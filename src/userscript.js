// ==UserScript==
// @name         Railfinder route map
// @namespace    railfinder-hacks
// @version      0.10.0
// @description  Map Railfinder journey routes.
// @match        https://www.railfinder.eu/search*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js
// @resource     LEAFLET_CSS https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// ==/UserScript==

(() => {
  "use strict";

  const LEG_INFO = ".travel-leg-info";
  const TRANSPORT_NAME = ".travel-leg-transport-name";
  const OPEN_RAIL_ROUTING_URL = "https://routing.openrailrouting.org/route";
  const ROUTE_PROFILE = "all_tracks";
  const ROUTE_CACHE_PREFIX = "railfinder.openrailrouting.v1:";
  const ROUTE_MAX_RETRIES = 2;
  const ROUTE_TIMEOUT_MS = 20000;
  const ROUTE_DEFAULT_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
  const ROUTE_MAX_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
  const journeyCards = new Set();
  const hoverTrackedCards = new WeakSet();
  const logoColorPromises = new Map();
  const logoColors = new Map();
  const routeGeometryCache = new Map();
  const pendingRouteRequests = new Map();
  const routeFailures = new Map();
  const routeQueue = [];
  let routeQueueActive = false;
  let routeServiceBlockedReason = null;
  let nextRouteRequestAt = 0;
  let routeLayersByKey = new Map();
  let currentPairFeatures = null;
  let resultsRoot;
  let originalResultsStyle;
  let originalBodyOverflow;
  let mapPane;
  let mapContainer;
  let mapStatus;
  let routeMap;
  let casingLayer;
  let routeLayer;
  let hoveredJourneyRank = null;
  let mapVisible = false;
  let mapAutoStarted = false;
  let mapHasFittedData = false;

  GM_addStyle(GM_getResourceText("LEAFLET_CSS"));

  function trackCard(card) {
    journeyCards.add(card);
    if (hoverTrackedCards.has(card)) return;
    hoverTrackedCards.add(card);
    card.addEventListener("mouseenter", () => setHoveredRoute(card.dataset.rank));
    card.addEventListener("mouseleave", () => setHoveredRoute(null));
  }

  function rememberCards(node) {
    if (!(node instanceof Element)) return;
    if (node.matches("[data-rank]")) trackCard(node);
    node.querySelectorAll("[data-rank]").forEach(trackCard);
  }

  function parsePoint(value) {
    const values = value?.trim().split(/\s+/).map(Number);
    if (!values || values.length !== 2) return null;

    const [latitude, longitude] = values;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return [longitude, latitude];
  }

  function parseDuration(value) {
    const match = value.trim().match(
      /^(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i,
    );
    if (!match || !match.slice(1).some(Boolean)) return null;

    const [, days = "0", hours = "0", minutes = "0"] = match;
    return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60;
  }

  function durationIn(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const seconds = parseDuration(walker.currentNode.nodeValue);
      if (seconds !== null) return seconds;
    }
    return null;
  }

  function legScope(info, card) {
    // Find the closest container that holds this leg's info and transport name.
    for (let element = info.parentElement; element && element !== card; element = element.parentElement) {
      if (element.querySelectorAll(LEG_INFO).length === 1
        && element.querySelectorAll(TRANSPORT_NAME).length === 1) return element;
    }
    return null;
  }

  function legDuration(info, card) {
    for (let element = info.parentElement; element && element !== card; element = element.parentElement) {
      if (element.querySelectorAll(LEG_INFO).length !== 1
        || element.querySelectorAll(TRANSPORT_NAME).length !== 1) continue;
      const seconds = durationIn(element);
      if (seconds !== null) return seconds;
    }
    return null;
  }

  function distanceKm([longitude1, latitude1], [longitude2, latitude2]) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const lat1 = radians(latitude1);
    const lat2 = radians(latitude2);
    const deltaLat = lat2 - lat1;
    const deltaLon = radians(longitude2 - longitude1);
    const a = Math.min(1, Math.sin(deltaLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2);
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function cleanText(element) {
    return element?.textContent.replace(/\s+/g, " ").trim() || null;
  }

  function rankValue(rank) {
    return Number(rank) || rank;
  }

  function operatorFor(info, card, transport) {
    const logo = legScope(info, card)?.querySelector("img[alt]");
    const name = logo?.alt.trim() || cleanText(transport)?.split("•")[0].trim() || null;
    const logoUrl = logo?.currentSrc || logo?.src || null;
    return { name, logoUrl };
  }

  function featureFor(card, info, index, transport) {
    const from = parsePoint(info.dataset.departurePoint);
    const to = parsePoint(info.dataset.arrivalPoint);
    if (!from || !to) return null;

    const durationSeconds = legDuration(info, card);
    const straightLineDistanceKm = distanceKm(from, to);
    const operator = operatorFor(info, card, transport);
    const properties = {
      journeyRank: rankValue(card.dataset.rank),
      from: info.dataset.departureStationName || null,
      to: info.dataset.arrivalStationName || null,
      fromStationId: info.dataset.departureStation || null,
      toStationId: info.dataset.arrivalStation || null,
      transport: cleanText(transport),
      operator: operator.name,
      operatorLogoUrl: operator.logoUrl,
      durationSeconds,
      straightLineAverageSpeedKmh: durationSeconds
        ? Number((straightLineDistanceKm / (durationSeconds / 3600)).toFixed(1))
        : null,
    };

    return {
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates: [from, to] },
    };
  }

  function currentFeatures() {
    const features = [];
    for (const card of journeyCards) {
      const infos = card.querySelectorAll(LEG_INFO);
      if (!infos.length) continue;
      const transports = card.querySelectorAll(TRANSPORT_NAME);
      infos.forEach((info, index) => {
        const feature = featureFor(card, info, index, transports[index]);
        if (feature) features.push(feature);
      });
    }
    return features;
  }

  function stationPairKey(feature) {
    const p = feature.properties;
    return JSON.stringify([p.fromStationId || p.from, p.toStationId || p.to]);
  }

  function consolidateByStationPair(features) {
    const pairs = new Map();
    for (const feature of features) {
      const p = feature.properties;
      const key = stationPairKey(feature);
      let pair = pairs.get(key);
      if (!pair) {
        pair = {
          feature: {
            type: "Feature",
            geometry: feature.geometry,
            properties: {
              from: p.from,
              to: p.to,
              fromStationId: p.fromStationId,
              toStationId: p.toStationId,
              count: 0,
              maxStraightLineAverageSpeedKmh: null,
              maxSpeedDurationSeconds: null,
              maxSpeedTransport: null,
              operator: null,
              operatorLogoUrl: null,
              operatorsByJourney: [],
            },
          },
          journeyRanks: new Set(),
        };
        pairs.set(key, pair);
      }

      const properties = pair.feature.properties;
      if (!pair.journeyRanks.has(p.journeyRank)) {
        pair.journeyRanks.add(p.journeyRank);
        properties.operatorsByJourney.push({
          journeyRank: p.journeyRank,
          operator: p.operator,
          operatorLogoUrl: p.operatorLogoUrl,
        });
      }
      const speed = p.straightLineAverageSpeedKmh;
      if (speed !== null && (properties.maxStraightLineAverageSpeedKmh === null
        || speed > properties.maxStraightLineAverageSpeedKmh)) {
        properties.maxStraightLineAverageSpeedKmh = speed;
        properties.maxSpeedDurationSeconds = p.durationSeconds;
        properties.maxSpeedTransport = p.transport;
        properties.operator = p.operator;
        properties.operatorLogoUrl = p.operatorLogoUrl;
      }
    }
    return [...pairs.values()].map(({ feature, journeyRanks }) => {
      feature.properties.count = journeyRanks.size;
      feature.properties.journeyRanks = [...journeyRanks];
      return feature;
    });
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return "unknown";
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  }

  function operatorFallbackColor(name) {
    let hash = 0;
    for (const character of name || "unknown") {
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return `hsl(${(hash >>> 0) % 360}, 70%, 40%)`;
  }

  function dominantLogoColor(image) {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const colors = new Map();

    for (let i = 0; i < pixels.length; i += 4) {
      const red = pixels[i];
      const green = pixels[i + 1];
      const blue = pixels[i + 2];
      if (pixels[i + 3] < 128 || (red > 235 && green > 235 && blue > 235)) continue;
      const key = `${red >> 4},${green >> 4},${blue >> 4}`;
      const color = colors.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      color.count += 1;
      color.red += red;
      color.green += green;
      color.blue += blue;
      colors.set(key, color);
    }

    const dominant = [...colors.values()].sort((a, b) => b.count - a.count)[0];
    if (!dominant) return null;
    return `rgb(${Math.round(dominant.red / dominant.count)},${Math.round(dominant.green / dominant.count)},${Math.round(dominant.blue / dominant.count)})`;
  }

  function loadLogoColor(url) {
    if (!url) return Promise.resolve(null);
    if (logoColorPromises.has(url)) return logoColorPromises.get(url);
    let source;
    try {
      source = new URL(url, location.href);
    } catch {
      return Promise.resolve(null);
    }

    const promise = new Promise((resolve) => {
      const image = document.createElement("img");
      if (source.origin !== location.origin) image.crossOrigin = "anonymous";
      const readColor = () => {
        try {
          resolve(dominantLogoColor(image));
        } catch {
          resolve(null);
        }
      };
      image.onload = readColor;
      image.onerror = () => resolve(null);
      image.src = source.href;
      if (image.complete && image.naturalWidth) readColor();
    }).then((color) => {
      if (color) logoColors.set(url, color);
      return color;
    });
    logoColorPromises.set(url, promise);
    return promise;
  }

  function warmLogoColors(features) {
    const urls = new Set();
    for (const { properties } of features) {
      if (properties.operatorLogoUrl) urls.add(properties.operatorLogoUrl);
      properties.operatorsByJourney?.forEach(({ operatorLogoUrl }) => {
        if (operatorLogoUrl) urls.add(operatorLogoUrl);
      });
    }
    Promise.all([...urls].map(loadLogoColor)).then(() => {
      if (!routeLayer) return;
      routeLayer.setStyle(featureStyle);
      if (hoveredJourneyRank !== null) setHoveredRoute(hoveredJourneyRank);
    });
  }

  function railRouteKey(feature) {
    const p = feature.properties;
    const coordinates = feature.geometry.coordinates;
    const endpoints = [coordinates[0], coordinates[coordinates.length - 1]]
      .map(([lon, lat]) => [lon.toFixed(5), lat.toFixed(5)]);
    return ROUTE_CACHE_PREFIX + encodeURIComponent(JSON.stringify([
      ROUTE_PROFILE,
      p.fromStationId || p.from,
      p.toStationId || p.to,
      endpoints,
    ]));
  }

  function validRouteCoordinates(coordinates) {
    return Array.isArray(coordinates) && coordinates.length >= 2
      && coordinates.every((point) => Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1])
        && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
  }

  function cachedRouteCoordinates(key) {
    if (routeGeometryCache.has(key)) return routeGeometryCache.get(key);
    try {
      const item = JSON.parse(localStorage.getItem(key));
      if (item?.expiresAt > Date.now() && validRouteCoordinates(item.coordinates)) {
        routeGeometryCache.set(key, item.coordinates);
        return item.coordinates;
      }
      if (item) localStorage.removeItem(key);
    } catch {
      // Ignore unavailable or invalid local storage entries.
    }
    return null;
  }

  function routeCacheLifetime(headers) {
    const directives = headers.get("Cache-Control") || "";
    if (/\bno-store\b|\bno-cache\b/i.test(directives)) return 0;
    const age = Math.max(0, Number(headers.get("Age")) || 0) * 1000;
    const maxAge = directives.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)/i);
    let lifetime = maxAge
      ? Number(maxAge[1]) * 1000 - age
      : Date.parse(headers.get("Expires") || "") - Date.now() - age;
    if (!Number.isFinite(lifetime)) lifetime = ROUTE_DEFAULT_CACHE_MS;
    return Math.max(0, Math.min(lifetime, ROUTE_MAX_CACHE_MS));
  }

  function storeRouteCoordinates(key, coordinates, headers) {
    const lifetime = routeCacheLifetime(headers);
    if (!lifetime) return;
    routeGeometryCache.set(key, coordinates);
    try {
      localStorage.setItem(key, JSON.stringify({
        expiresAt: Date.now() + lifetime,
        coordinates,
      }));
    } catch {
      // Keep the route in memory if local storage is full or blocked.
    }
  }

  function retryAfterMilliseconds(response) {
    const value = response.headers.get("Retry-After");
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }

    const reset = response.headers.get("RateLimit-Reset")
      || response.headers.get("X-RateLimit-Reset");
    if (reset === null) return null;
    const resetValue = Number(reset);
    if (Number.isFinite(resetValue)) {
      return Math.max(0, resetValue > 1e9 ? resetValue * 1000 - Date.now() : resetValue * 1000);
    }
    const resetDate = Date.parse(reset);
    return Number.isFinite(resetDate) ? Math.max(0, resetDate - Date.now()) : null;
  }

  function waitUntil(timestamp) {
    return new Promise((resolve) => {
      const poll = () => {
        const remaining = timestamp - Date.now();
        if (remaining <= 0) resolve();
        else window.setTimeout(poll, Math.min(remaining, 2_147_000_000));
      };
      poll();
    });
  }

  async function fetchRailRoute(feature) {
    const [from, to] = feature.geometry.coordinates.length === 2
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates[0], feature.geometry.coordinates.at(-1)];
    const url = new URL(OPEN_RAIL_ROUTING_URL);
    for (const [lon, lat] of [from, to]) url.searchParams.append("point", `${lat},${lon}`);
    url.searchParams.set("profile", ROUTE_PROFILE);
    url.searchParams.set("instructions", "false");
    url.searchParams.set("points_encoded", "false");

    for (let attempt = 0; attempt <= ROUTE_MAX_RETRIES; attempt += 1) {
      await waitUntil(nextRouteRequestAt);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          cache: "default",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (/text\/html/i.test(response.headers.get("Content-Type") || "")) {
          routeServiceBlockedReason = "challenge page returned";
          return null;
        }
        if ([401, 403, 404, 501].includes(response.status)) {
          routeServiceBlockedReason = response.status === 501
            ? "requested profile unsupported"
            : "authentication, endpoint, or access denied";
          return null;
        }
        if (response.ok) {
          const data = await response.json();
          const points = data.paths?.[0]?.points;
          const coordinates = points?.coordinates || points;
          if (!Array.isArray(coordinates)) {
            if (data.paths?.length) routeServiceBlockedReason = "unexpected geometry format";
            return null;
          }
          if (!validRouteCoordinates(coordinates)) return null;
          return { coordinates: coordinates.map(([lon, lat]) => [lon, lat]), headers: response.headers };
        }
      } catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) {
          routeServiceBlockedReason = error instanceof TypeError
            ? "CORS or network error"
            : "invalid response (possibly a challenge)";
          return null;
        }
        const delay = 1500 * 2 ** attempt + Math.random() * 500;
        nextRouteRequestAt = Math.max(nextRouteRequestAt, Date.now() + delay);
        if (attempt === ROUTE_MAX_RETRIES) return null;
        continue;
      } finally {
        window.clearTimeout(timeout);
      }

      const retryAfter = retryAfterMilliseconds(response);
      if (retryAfter !== null) {
        nextRouteRequestAt = Math.max(nextRouteRequestAt, Date.now() + retryAfter);
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === ROUTE_MAX_RETRIES) return null;
      const backoff = retryAfter ?? (response.status === 429 ? 30000 : 5000) * 2 ** attempt;
      nextRouteRequestAt = Math.max(nextRouteRequestAt, Date.now() + backoff);
    }
    return null;
  }

  function updateRoutingStatus() {
    if (!mapStatus || !currentPairFeatures?.length) return;
    if (routeServiceBlockedReason) {
      mapStatus.textContent = `OpenRailRouting unavailable (${routeServiceBlockedReason}); unresolved pairs use straight lines.`;
      return;
    }
    let ready = 0;
    let pending = 0;
    for (const feature of currentPairFeatures) {
      const key = railRouteKey(feature);
      if (cachedRouteCoordinates(key)) ready += 1;
      else if (pendingRouteRequests.has(key)) pending += 1;
    }
    const fallback = currentPairFeatures.length - ready - pending;
    mapStatus.textContent = `Rail routes: ${ready}/${currentPairFeatures.length} loaded; ${pending} pending${fallback ? `; ${fallback} using station-to-station lines` : ""}.`;
  }

  function processRouteQueue() {
    if (routeQueueActive || !routeQueue.length) return;
    routeQueue.sort((a, b) => b.priority - a.priority);
    routeQueueActive = true;
    const job = routeQueue.shift();
    fetchRailRoute(job.feature).then((result) => {
      if (result) {
        storeRouteCoordinates(job.key, result.coordinates, result.headers);
        routeFailures.delete(job.key);
        job.resolve(result.coordinates);
      } else {
        routeFailures.set(job.key, Date.now() + 10 * 60 * 1000);
        job.resolve(null);
      }
    }).catch(() => {
      routeFailures.set(job.key, Date.now() + 10 * 60 * 1000);
      job.resolve(null);
    }).finally(() => {
      pendingRouteRequests.delete(job.key);
      routeQueueActive = false;
      if (routeServiceBlockedReason) cancelQueuedRoutes();
      updateRoutingStatus();
      if (routeQueue.length) {
        window.setTimeout(processRouteQueue, Math.max(0, nextRouteRequestAt - Date.now()));
      }
    });
  }

  function requestRailRoute(feature) {
    if (routeServiceBlockedReason) return Promise.resolve(null);
    const key = railRouteKey(feature);
    const cached = cachedRouteCoordinates(key);
    if (cached) return Promise.resolve(cached);
    if (pendingRouteRequests.has(key)) return pendingRouteRequests.get(key);
    if ((routeFailures.get(key) || 0) > Date.now()) return Promise.resolve(null);

    const promise = new Promise((resolve) => {
      const [from, to] = feature.geometry.coordinates;
      routeQueue.push({ key, feature, resolve, priority: feature.properties.count * distanceKm(from, to) });
    });
    pendingRouteRequests.set(key, promise);
    promise.then((coordinates) => {
      const layer = routeLayersByKey.get(key);
      if (coordinates && layer && mapVisible) {
        for (const route of [layer.line, layer.casing]) {
          route.feature.geometry.coordinates = coordinates;
          route.setLatLngs(coordinates.map(([lon, lat]) => [lat, lon]));
        }
      }
      updateRoutingStatus();
    });
    return promise;
  }

  function cancelQueuedRoutes() {
    for (const job of routeQueue.splice(0)) {
      pendingRouteRequests.delete(job.key);
      job.resolve(null);
    }
  }

  function makePopup(feature) {
    const p = feature.properties;
    const content = document.createElement("div");
    const rows = [
      ["From", p.from],
      ["To", p.to],
      ["Count", p.count],
      ["Leg duration", formatDuration(p.maxSpeedDurationSeconds)],
      ["Max straight-line speed", p.maxStraightLineAverageSpeedKmh],
      ["Operator", p.operator],
      ["Transport", p.maxSpeedTransport ?? p.transport],
    ];
    for (const [label, value] of rows) {
      if (value === undefined || value === null) continue;
      const row = document.createElement("div");
      row.textContent = `${label}: ${value}${label.includes("speed") ? " km/h" : ""}`;
      content.append(row);
    }
    return content;
  }

  function lineWeight(feature, selected = false) {
    const count = feature.properties.count;
    return selected || count === undefined ? 3 : Math.min(12, 2 + count);
  }

  function isHoveredFeature(feature) {
    return feature.properties.journeyRanks?.includes(hoveredJourneyRank);
  }

  function featureStyle(feature) {
    const p = feature.properties;
    const speed = p.maxStraightLineAverageSpeedKmh;
    const speedColor = speed >= 100 ? "#dc2626" : speed >= 60 ? "#ea580c" : "#2563eb";
    const selected = isHoveredFeature(feature);
    if (hoveredJourneyRank === null) return { color: speedColor, weight: lineWeight(feature), opacity: 0.8 };
    if (!selected) return { color: speedColor, weight: lineWeight(feature), opacity: 0.12 };

    const operator = p.operatorsByJourney?.find((entry) => entry.journeyRank === hoveredJourneyRank) || p;
    const color = logoColors.get(operator.operatorLogoUrl) || operatorFallbackColor(operator.operator);
    return { color, weight: lineWeight(feature, true), opacity: 1 };
  }

  function casingStyle(feature) {
    const style = featureStyle(feature);
    return { ...style, color: "#fff", weight: style.weight + 2 };
  }

  function setHoveredRoute(rank) {
    hoveredJourneyRank = rank === null ? null : rankValue(rank);
    if (!routeLayer) return;
    routeLayer.setStyle(featureStyle);
    casingLayer?.setStyle(casingStyle);
    routeLayer.eachLayer((layer) => {
      if (isHoveredFeature(layer.feature)) layer.bringToFront();
    });
  }

  function renderMap(forceFit = false) {
    if (!routeMap) return;
    if (casingLayer) routeMap.removeLayer(casingLayer);
    if (routeLayer) routeMap.removeLayer(routeLayer);
    casingLayer = routeLayer = null;
    routeLayersByKey = new Map();

    const features = consolidateByStationPair(currentFeatures());
    currentPairFeatures = features;
    for (const feature of features) {
      const cached = cachedRouteCoordinates(railRouteKey(feature));
      if (cached) feature.geometry.coordinates = cached;
    }
    mapStatus.textContent = features.length
      ? `Showing ${features.length} station pairs. Loading by count × straight-line distance via OpenRailRouting…`
      : "Waiting for route results…";
    if (!features.length) {
      updateRoutingStatus();
      return;
    }

    const collection = { type: "FeatureCollection", features };
    casingLayer = L.geoJSON(collection, {
      style: casingStyle,
      interactive: false,
      onEachFeature: (feature, layer) => {
        routeLayersByKey.set(railRouteKey(feature), { casing: layer });
      },
    }).addTo(routeMap);
    routeLayer = L.geoJSON(collection, {
      style: featureStyle,
      onEachFeature: (feature, layer) => {
        layer.bindPopup(makePopup(feature));
        const key = railRouteKey(feature);
        const layers = routeLayersByKey.get(key) || {};
        layers.line = layer;
        routeLayersByKey.set(key, layers);
      },
    }).addTo(routeMap);
    warmLogoColors(features);
    if (hoveredJourneyRank !== null) setHoveredRoute(hoveredJourneyRank);
    features.forEach((feature) => requestRailRoute(feature));
    updateRoutingStatus();
    processRouteQueue();

    const bounds = routeLayer.getBounds();
    if (bounds.isValid() && (forceFit || !mapHasFittedData)) {
      routeMap.fitBounds(bounds.pad(0.1), { maxZoom: 9 });
      mapHasFittedData = true;
    }
  }

  function resizeMapPane() {
    if (!mapVisible || !resultsRoot || !mapPane) return;
    const wide = window.matchMedia("(min-width: 1100px)").matches;
    Object.assign(resultsRoot.style, {
      position: "fixed",
      inset: "0 auto auto 0",
      width: wide ? "50vw" : "100vw",
      height: wide ? "100vh" : "50vh",
      minHeight: "0",
      boxSizing: "border-box",
      overflowY: "auto",
      overflowX: "hidden",
      zIndex: "2147483645",
    });
    Object.assign(mapPane.style, {
      position: "fixed",
      inset: wide ? "0 0 0 50vw" : "auto 0 0 0",
      width: wide ? "50vw" : "100vw",
      height: wide ? "100vh" : "50vh",
      borderLeft: wide ? "1px solid #cbd5e1" : "none",
      borderTop: wide ? "none" : "1px solid #cbd5e1",
      zIndex: "2147483646",
    });
    if (routeMap) requestAnimationFrame(() => routeMap.invalidateSize());
  }

  function mountMapPane() {
    if (resultsRoot) return true;
    const card = [...journeyCards].find((item) => item.isConnected);
    resultsRoot = document.querySelector('[data-controller~="filter"]')
      || card?.closest('[data-controller~="filter"]');
    if (!resultsRoot) return false;

    originalResultsStyle = resultsRoot.getAttribute("style");
    originalBodyOverflow = document.body.style.overflow;
    document.body.append(mapPane);
    return true;
  }

  function closeMapPane() {
    mapVisible = false;
    mapPane.style.display = "none";
    if (resultsRoot) {
      if (originalResultsStyle === null) resultsRoot.removeAttribute("style");
      else resultsRoot.setAttribute("style", originalResultsStyle);
    }
    document.body.style.overflow = originalBodyOverflow;
    window.removeEventListener("resize", resizeMapPane);
    cancelQueuedRoutes();
  }

  function createMapPane() {
    mapPane = document.createElement("section");
    mapPane.style.cssText = "position:fixed;display:none;flex-direction:column;min-width:0;box-sizing:border-box;padding:12px;background:white;box-shadow:0 2px 10px #0002";
    mapPane.setAttribute("aria-label", "Rail route map");

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;font:14px sans-serif";
    const title = document.createElement("strong");
    title.textContent = "Railfinder station-pair routes";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Hide map";
    mapStatus = document.createElement("span");
    mapStatus.style.cssText = "flex:1 1 100%;color:#475569";
    for (const button of [close]) {
      button.style.cssText = "padding:6px 10px;border:1px solid #94a3b8;border-radius:4px;background:white;cursor:pointer";
    }
    toolbar.append(title, close, mapStatus);

    mapContainer = document.createElement("div");
    mapContainer.style.cssText = "flex:1;min-height:0;width:100%;border-radius:4px";
    mapPane.append(toolbar, mapContainer);
    close.addEventListener("click", closeMapPane);
  }

  function openMap() {
    if (!mapPane) createMapPane();
    if (!mountMapPane()) return false;
    mapAutoStarted = true;
    mapVisible = true;
    mapPane.style.display = "flex";
    document.body.style.overflow = "hidden";
    window.addEventListener("resize", resizeMapPane);
    resizeMapPane();
    requestAnimationFrame(() => {
      if (typeof L === "undefined") {
        mapStatus.textContent = "Leaflet did not load. Check the userscript CDN access.";
        return;
      }
      if (!routeMap) {
        routeMap = L.map(mapContainer);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        }).addTo(routeMap);
        routeMap.attributionControl.addAttribution(
          '© <a href="https://routing.openrailrouting.org/">OpenRailRouting</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        );
        routeMap.setView([51, 7], 5);
      }
      routeMap.invalidateSize();
      renderMap(true);
    });
    return true;
  }

  function scheduleMapUpdate() {
    if (!mapVisible || mapUpdateTimer) return;
    const delay = Math.max(0, 250 - (performance.now() - lastMapUpdate));
    mapUpdateTimer = window.setTimeout(() => {
      mapUpdateTimer = null;
      lastMapUpdate = performance.now();
      if (mapVisible) renderMap();
    }, delay);
  }

  rememberCards(document.documentElement);

  const observer = new MutationObserver((records) => {
    let routesChanged = false;
    for (const record of records) {
      if (record.type === "attributes") {
        const card = record.target.matches("[data-rank]")
          ? record.target
          : record.target.closest("[data-rank]");
        if (card) {
          rememberCards(card);
          routesChanged = true;
        }
        continue;
      }

      const target = record.target.nodeType === Node.ELEMENT_NODE
        ? record.target
        : record.target.parentElement;
      const targetCard = target?.closest("[data-rank]");
      if (targetCard && journeyCards.has(targetCard)) routesChanged = true;
      for (const node of record.addedNodes) {
        if (node instanceof Element
          && (node.matches("[data-rank]") || node.querySelector("[data-rank]"))) {
          routesChanged = true;
        }
        rememberCards(node);
      }
    }
    if (!mapAutoStarted && document.querySelector('[data-controller~="filter"]')) openMap();
    if (routesChanged) scheduleMapUpdate();
  });

  let mapUpdateTimer;
  let lastMapUpdate = 0;
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-rank",
      "data-departure-station",
      "data-departure-station-name",
      "data-departure-point",
      "data-arrival-station",
      "data-arrival-station-name",
      "data-arrival-point",
      "src",
      "srcset",
      "alt",
    ],
  });
  openMap();
})();
