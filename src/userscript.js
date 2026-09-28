// ==UserScript==
// @name         Railfinder route map
// @namespace    railfinder-hacks
// @version      0.17.3
// @author       bovine3dom
// @description  map for railfinder.eu search results
// @match        https://www.railfinder.eu/search*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js
// @resource     LEAFLET_CSS https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css
// @updateURL    https://raw.githubusercontent.com/bovine3dom/railfinder_hacks/master/src/content.user.js
// @downloadURL  https://raw.githubusercontent.com/bovine3dom/railfinder_hacks/master/src/content.user.js
// @supportURL   https://github.com/bovine3dom/railfinder_hacks/issues/
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
  const MAX_CONCURRENT_ROUTE_REQUESTS = 3;
  const ROUTE_TIMEOUT_MS = 20000;
  const ROUTE_DEFAULT_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
  const ROUTE_MAX_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
  const journeyCards = new Set();
  const hoverTrackedCards = new WeakSet();
  let mapLeaveTimer;
  let selectedCard;
  let resultsRoot;
  const logoColorPromises = new Map();
  const logoColors = new Map();
  const routeGeometryCache = new Map();
  const displayRouteCache = new Map();
  const pendingRouteRequests = new Map();
  const routeFailures = new Map();
  const routeQueue = [];
  let activeRouteRequests = 0;
  let routeQueueTimer = null;
  let routeServiceBlockedReason = null;
  let nextRouteRequestAt = 0;
  let routeLayersByKey = new Map();
  let currentPairFeatures = null;
  let pageRoot;
  let mapReopenButton;
  let mapPane;
  let mapContainer;
  let routeMap;
  let casingLayer;
  let routeLayer;
  let trainLabelLayer;
  let hoveredLabelRecords = [];
  let labelLayoutFrame = 0;
  let hoveredJourneyRank = null;
  let mapVisible = false;
  let mapAutoStarted = false;
  let mapHasFittedData = false;
  let lastRenderedFeatureSignature = null;

  GM_addStyle(GM_getResourceText("LEAFLET_CSS"));
  GM_addStyle(`
    .railfinder-train-label-icon{background:transparent;border:0}
    .railfinder-map-label{display:inline-block;white-space:nowrap;line-height:1;-webkit-text-stroke:3px white;paint-order:stroke fill;text-shadow:0 0 2px white;pointer-events:none}
    [data-railfinder-selected] > :first-child{outline:2px solid #d14d00;outline-offset:2px}
    .railfinder-split-page{position:relative;width:50vw;min-width:0}
    .railfinder-route-pane{position:fixed;inset:0 0 0 50vw;width:50vw;height:100vh;z-index:2147483646;box-sizing:border-box;padding:12px;background:#fff5f0;color:#122533;border-left:1px solid #ffd5bd;box-shadow:0 2px 10px #231f2026}
    .railfinder-map-button{padding:6px 12px;border:1px solid #ff985c;border-radius:12px;background:white;color:#d14d00;cursor:pointer}
    .railfinder-map-button:hover,.railfinder-map-button:focus-visible{background:#ffece0}
    .railfinder-reopen-button{position:fixed;right:16px;bottom:16px;z-index:2147483647;box-shadow:0 2px 8px #231f2026}
    @media(min-width:1100px){
      .railfinder-split-page nav > div > div > [class~="sm:flex"]{display:none}
      .railfinder-split-page nav > div > div > [class~="sm:hidden"]{display:flex}
      .railfinder-split-page nav > [class~="sm:hidden"]:not(.hidden){display:block}
    }
    @media(max-width:1099px){
      .railfinder-split-page{width:auto;padding-bottom:50vh}
      .railfinder-route-pane{inset:auto 0 0;width:100vw;height:50vh;border-left:0;border-top:1px solid #ffd5bd}
    }
  `);

  function trackCard(card) {
    journeyCards.add(card);
    if (hoverTrackedCards.has(card)) return;
    hoverTrackedCards.add(card);
    card.addEventListener("mouseenter", () => {
      if (mapVisible) setHoveredRoute(card.dataset.rank);
    });
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

  function clockTimes(card) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    const times = [];
    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue.trim();
      if (/^\d{1,2}:\d{2}$/.test(value)) times.push({ node: walker.currentNode, value });
    }
    return times;
  }

  function legTimes(info, times) {
    let departureTime = null;
    let arrivalTime = null;
    for (const { node, value } of times) {
      const position = info.compareDocumentPosition(node);
      if (position & Node.DOCUMENT_POSITION_PRECEDING) departureTime = value;
      else if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        arrivalTime = value;
        break;
      }
    }
    return { departureTime, arrivalTime };
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

  function cleanText(value) {
    const text = typeof value === "string" ? value : value?.textContent;
    return text?.replace(/\s+/g, " ").trim() || null;
  }

  function rankValue(rank) {
    return Number(rank) || rank;
  }

  function trainName(transport) {
    const name = cleanText(transport);
    return name?.split("•").at(-1).trim() || name;
  }

  function operatorFor(info, card, transport) {
    const logo = legScope(info, card)?.querySelector("img[alt]");
    const name = logo?.alt.trim() || cleanText(transport)?.split("•")[0].trim() || null;
    const logoUrl = logo?.currentSrc || logo?.src || null;
    return { name, logoUrl };
  }

  function featureFor(card, info, index, transport, times) {
    const from = parsePoint(info.dataset.departurePoint);
    const to = parsePoint(info.dataset.arrivalPoint);
    if (!from || !to) return null;

    const durationSeconds = legDuration(info, card);
    const { departureTime, arrivalTime } = legTimes(info, times);
    const operator = operatorFor(info, card, transport);
    const properties = {
      journeyRank: rankValue(card.dataset.rank),
      legIndex: index,
      from: info.dataset.departureStationName || null,
      to: info.dataset.arrivalStationName || null,
      fromStationId: info.dataset.departureStation || null,
      toStationId: info.dataset.arrivalStation || null,
      transport: cleanText(transport),
      departureTime,
      arrivalTime,
      operator: operator.name,
      operatorLogoUrl: operator.logoUrl,
      straightLineAverageSpeedKmh: durationSeconds
        ? Number((distanceKm(from, to) / (durationSeconds / 3600)).toFixed(1))
        : null,
    };

    return {
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates: [from, to] },
    };
  }

  function currentFeatures(rank = null) {
    const features = [];
    for (const card of journeyCards) {
      if (!card.isConnected) {
        journeyCards.delete(card);
        continue;
      }
      if ((rank !== null && rankValue(card.dataset.rank) !== rank)
        || !card.getClientRects().length) continue;
      const infos = card.querySelectorAll(LEG_INFO);
      if (!infos.length) continue;
      const transports = card.querySelectorAll(TRANSPORT_NAME);
      const times = clockTimes(card);
      infos.forEach((info, index) => {
        const feature = featureFor(card, info, index, transports[index], times);
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
              routeKey: railRouteKey(feature),
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
          trainName: trainName(p.transport),
          departureTime: p.departureTime,
          arrivalTime: p.arrivalTime,
        });
      }
      const speed = p.straightLineAverageSpeedKmh;
      if (speed !== null && (properties.maxStraightLineAverageSpeedKmh === null
        || speed > properties.maxStraightLineAverageSpeedKmh)) {
        properties.maxStraightLineAverageSpeedKmh = speed;
      }
    }
    return [...pairs.values()].map(({ feature, journeyRanks }) => {
      feature.properties.count = journeyRanks.size;
      feature.properties.journeyRanks = [...journeyRanks];
      return feature;
    });
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
    const layer = routeLayer;
    Promise.all([...urls].map(loadLogoColor)).then(() => {
      if (routeLayer !== layer || !mapVisible) return;
      routeLayer.setStyle(featureStyle);
      if (hoveredJourneyRank !== null) setHoveredRoute(hoveredJourneyRank, true);
    });
  }

  function railRouteKey(feature) {
    const p = feature.properties;
    if (p.routeKey) return p.routeKey;
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

  function displayRouteCoordinates(key, coordinates) {
    if (displayRouteCache.has(key)) return displayRouteCache.get(key);
    const points = coordinates.map((coordinate) => {
      const point = routeMap.project([coordinate[1], coordinate[0]], 14);
      point.coordinates = coordinate;
      return point;
    });
    const simplified = L.LineUtil.simplify(points, 1).map((point) => point.coordinates);
    displayRouteCache.set(key, simplified);
    return simplified;
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
    if (!currentPairFeatures?.length) return;
    if (routeServiceBlockedReason) {
      return;
    }
    let ready = 0;
    let pending = 0;
    for (const feature of currentPairFeatures) {
      const key = railRouteKey(feature);
      if (cachedRouteCoordinates(key)) ready += 1;
      else if (pendingRouteRequests.has(key)) pending += 1;
    }
  }

  function processRouteQueue() {
    if (routeServiceBlockedReason) return cancelQueuedRoutes();
    if (!routeQueue.length || activeRouteRequests >= MAX_CONCURRENT_ROUTE_REQUESTS) return;
    const delay = nextRouteRequestAt - Date.now();
    if (delay > 0) {
      if (!routeQueueTimer) {
        routeQueueTimer = window.setTimeout(() => {
          routeQueueTimer = null;
          processRouteQueue();
        }, delay);
      }
      return;
    }

    routeQueue.sort((a, b) => b.priority - a.priority);
    while (routeQueue.length && activeRouteRequests < MAX_CONCURRENT_ROUTE_REQUESTS) {
      const job = routeQueue.shift();
      activeRouteRequests += 1;
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
        activeRouteRequests -= 1;
        if (routeServiceBlockedReason) cancelQueuedRoutes();
        updateRoutingStatus();
        processRouteQueue();
      });
    }
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
        const display = displayRouteCoordinates(key, coordinates);
        const latLngs = display.map(([lon, lat]) => [lat, lon]);
        for (const route of [layer.line, layer.casing]) {
          route.feature.geometry.coordinates = display;
          route.setLatLngs(latLngs);
        }
        if (hoveredJourneyRank !== null
          && layer.line.feature.properties.journeyRanks?.includes(hoveredJourneyRank)) {
          renderHoveredTrainLabels();
        }
      }
      updateRoutingStatus();
    });
    return promise;
  }

  function cancelQueuedRoutes() {
    if (routeQueueTimer) window.clearTimeout(routeQueueTimer);
    routeQueueTimer = null;
    for (const job of routeQueue.splice(0)) {
      pendingRouteRequests.delete(job.key);
      job.resolve(null);
    }
  }

  function lineWeight(feature, selected = false) {
    return selected ? 3 : Math.min(12, 2 + feature.properties.count);
  }

  function isHoveredFeature(feature) {
    return feature.properties.journeyRanks.includes(hoveredJourneyRank);
  }

  function featureStyle(feature) {
    const p = feature.properties;
    const speed = p.maxStraightLineAverageSpeedKmh;
    const speedColor = speed >= 100 ? "#dc2626" : speed >= 60 ? "#ea580c" : "#2563eb";
    const selected = isHoveredFeature(feature);
    if (hoveredJourneyRank === null) return { color: speedColor, weight: lineWeight(feature), opacity: 0.8 };
    if (!selected) return { color: speedColor, weight: lineWeight(feature), opacity: 0.12 };

    const operator = p.operatorsByJourney.find((entry) => entry.journeyRank === hoveredJourneyRank);
    const color = logoColors.get(operator.operatorLogoUrl) || operatorFallbackColor(operator.operator);
    return { color, weight: lineWeight(feature, true), opacity: 1 };
  }

  function casingStyle(feature) {
    const style = featureStyle(feature);
    return { ...style, color: "#fff", weight: style.weight + 2 };
  }

  function setLabelOffset(element, [x, y]) {
    element.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
  }

  function layoutHoveredLabels() {
    if (!trainLabelLayer) return;
    const viewport = mapContainer.getBoundingClientRect();
    const labels = hoveredLabelRecords.map((label) => ({
      ...label,
      rect: label.element.getBoundingClientRect(),
    }));
    const placed = [];
    const moves = [];
    for (const label of labels) {
      const { element, offsets, currentOffset, rect } = label;
      if (rect.right < viewport.left || rect.left > viewport.right
        || rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      let bestOffset;
      let bestRect;
      const place = (offset) => {
        const dx = offset[0] - currentOffset[0];
        const dy = offset[1] - currentOffset[1];
        const candidate = {
          left: rect.left + dx,
          right: rect.right + dx,
          top: rect.top + dy,
          bottom: rect.bottom + dy,
        };
        if (candidate.right < viewport.left || candidate.left > viewport.right
          || candidate.bottom < viewport.top || candidate.top > viewport.bottom
          || placed.some((other) => candidate.left < other.right + 4
            && candidate.right + 4 > other.left && candidate.top < other.bottom + 4
            && candidate.bottom + 4 > other.top)) return false;
        bestOffset = offset;
        bestRect = candidate;
        return true;
      };
      if (![currentOffset, ...offsets, [0, 0]].some(place)) {
        const steps = Math.ceil(Math.max(viewport.width, viewport.height) / 28);
        for (let step = 1; step <= steps; step += 1) {
          if ([[0, -step], [0, step], [-step, 0], [step, 0],
            [-step, -step], [step, -step], [-step, step], [step, step]]
            .some(([x, y]) => place([x * 28, y * 28]))) break;
        }
      }
      moves.push({ element, label, bestOffset });
      if (bestRect) placed.push(bestRect);
    }
    for (const { element, label, bestOffset } of moves) {
      element.style.visibility = bestOffset ? "" : "hidden";
      if (bestOffset) {
        setLabelOffset(element, bestOffset);
        label.currentOffset = bestOffset;
      }
    }
  }

  function scheduleLabelLayout() {
    if (!trainLabelLayer || labelLayoutFrame) return;
    labelLayoutFrame = requestAnimationFrame(() => {
      labelLayoutFrame = 0;
      layoutHoveredLabels();
    });
  }

  function renderHoveredTrainLabels() {
    if (trainLabelLayer) routeMap.removeLayer(trainLabelLayer);
    trainLabelLayer = null;
    hoveredLabelRecords = [];
    if (!routeMap || !routeLayer || hoveredJourneyRank === null) return;

    const transport = document.querySelector(TRANSPORT_NAME);
    const font = getComputedStyle(transport || pageRoot || document.body);
    const labels = L.layerGroup();
    const addLabel = (value, point, color, offsets, multiline = false) => {
      if (!value || !point) return;
      const text = document.createElement("span");
      text.className = "railfinder-map-label";
      text.textContent = value;
      text.style.fontFamily = font.fontFamily;
      text.style.fontSize = font.fontSize;
      text.style.fontWeight = font.fontWeight;
      text.style.color = color;
      text.style.textAlign = "center";
      text.style.whiteSpace = multiline ? "pre" : "nowrap";
      setLabelOffset(text, offsets[0]);
      const icon = L.divIcon({
        className: "railfinder-train-label-icon",
        html: text,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      });
      labels.addLayer(L.marker(point, { icon, interactive: false, keyboard: false }));
      hoveredLabelRecords.push({ element: text, offsets, currentOffset: offsets[0] });
    };
    const addStationLabel = (name, point, times) => {
      if (!name) return;
      const timeText = times.filter(Boolean).join(" ");
      addLabel(`${name}${timeText ? `\n${timeText}` : ""}`, point, "#172554", [
        [0, -24], [0, -44], [24, -24], [-24, -24], [24, 24], [-24, 24], [0, 44],
      ], Boolean(timeText));
    };

    routeLayer.eachLayer((layer) => {
      const feature = layer.feature;
      if (!isHoveredFeature(feature)) return;
      const journey = feature.properties.operatorsByJourney?.find(
        (entry) => entry.journeyRank === hoveredJourneyRank,
      );
      if (!journey?.trainName) return;
      const points = layer.getLatLngs();
      const middle = Math.floor(points.length / 2);
      const point = points[middle];
      if (!point) return;
      const before = routeMap.latLngToLayerPoint(points[Math.max(0, middle - 1)]);
      const after = routeMap.latLngToLayerPoint(points[Math.min(points.length - 1, middle + 1)]);
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      const length = Math.hypot(dx, dy) || 1;
      const side = hoveredJourneyRank % 2 ? 1 : -1;
      const normalX = -dy / length * side;
      const normalY = dx / length * side;
      const tangentX = dx / length;
      const tangentY = dy / length;
      const offsets = [16, 32, 48].map((distance) => [
        normalX * distance,
        normalY * distance,
      ]);
      for (const shift of [-48, -24, 24, 48]) {
        offsets.push([normalX * 16 + tangentX * shift, normalY * 16 + tangentY * shift]);
      }
      addLabel(journey.trainName, point, featureStyle(feature).color, offsets);
    });

    const legs = currentFeatures(hoveredJourneyRank)
      .sort((a, b) => a.properties.legIndex - b.properties.legIndex);
    if (legs.length) {
      const first = legs[0];
      const [startLongitude, startLatitude] = first.geometry.coordinates[0];
      addStationLabel(first.properties.from, L.latLng(startLatitude, startLongitude), [
        first.properties.departureTime && `dep: ${first.properties.departureTime}`,
      ]);
      const last = legs.at(-1);
      const [endLongitude, endLatitude] = last.geometry.coordinates.at(-1);
      addStationLabel(last.properties.to, L.latLng(endLatitude, endLongitude), [
        last.properties.arrivalTime && `arr: ${last.properties.arrivalTime}`,
      ]);
    }
    for (let index = 0; index < legs.length - 1; index += 1) {
      const leg = legs[index];
      const next = legs[index + 1];
      const sameStation = (leg.properties.toStationId && next.properties.fromStationId
        && leg.properties.toStationId === next.properties.fromStationId)
        || leg.properties.to === next.properties.from;
      const stationName = sameStation
        ? leg.properties.to
        : [leg.properties.to, next.properties.from].filter(Boolean).join(" → ");
      if (!stationName) continue;
      const [longitude, latitude] = leg.geometry.coordinates.at(-1);
      addStationLabel(stationName, L.latLng(latitude, longitude), [
        leg.properties.arrivalTime && `arr: ${leg.properties.arrivalTime}`,
        next.properties.departureTime && `dep: ${next.properties.departureTime}`,
      ]);
    }
    if (labels.getLayers().length) {
      trainLabelLayer = labels.addTo(routeMap);
      layoutHoveredLabels();
    }
  }

  function cardForRank(rank) {
    for (const card of journeyCards) {
      if (card.isConnected && rankValue(card.dataset.rank) === rank
        && card.getClientRects().length) return card;
    }
    return null;
  }

  function setHoveredRoute(rank, force = false) {
    const nextRank = rank === null ? null : rankValue(rank);
    if (!force && hoveredJourneyRank === nextRank) return;
    hoveredJourneyRank = nextRank;
    selectedCard?.removeAttribute("data-railfinder-selected");
    selectedCard = cardForRank(nextRank);
    selectedCard?.setAttribute("data-railfinder-selected", "");
    if (!routeLayer) {
      renderHoveredTrainLabels();
      return;
    }
    routeLayer.setStyle(featureStyle);
    casingLayer?.setStyle(casingStyle);
    routeLayer.eachLayer((layer) => {
      if (isHoveredFeature(layer.feature)) layer.bringToFront();
    });
    renderHoveredTrainLabels();
  }

  function renderMap(forceFit = false) {
    if (!routeMap) return;
    if (hoveredJourneyRank !== null && !cardForRank(hoveredJourneyRank)) setHoveredRoute(null);
    const features = consolidateByStationPair(currentFeatures());
    const signature = JSON.stringify(features.map((feature) => [railRouteKey(feature), feature.properties]));
    if (signature === lastRenderedFeatureSignature) {
      if (forceFit && routeLayer) {
        const bounds = routeLayer.getBounds();
        if (bounds.isValid()) routeMap.fitBounds(bounds.pad(0.1), { maxZoom: 9 });
      }
      return;
    }
    lastRenderedFeatureSignature = signature;
    if (casingLayer) routeMap.removeLayer(casingLayer);
    if (routeLayer) routeMap.removeLayer(routeLayer);
    casingLayer = routeLayer = null;
    renderHoveredTrainLabels();
    routeLayersByKey = new Map();
    currentPairFeatures = features;
    for (const feature of features) {
      const cached = cachedRouteCoordinates(railRouteKey(feature));
      if (cached) feature.geometry.coordinates = displayRouteCoordinates(railRouteKey(feature), cached);
    }
    if (!features.length) {
      updateRoutingStatus();
      return;
    }

    const collection = { type: "FeatureCollection", features };
    casingLayer = L.geoJSON(collection, {
      style: casingStyle,
      smoothFactor: 3,
      interactive: false,
      onEachFeature: (feature, layer) => {
        routeLayersByKey.set(railRouteKey(feature), { casing: layer });
      },
    }).addTo(routeMap);
    routeLayer = L.geoJSON(collection, {
      style: featureStyle,
      smoothFactor: 3,
      onEachFeature: (feature, layer) => {
        const key = railRouteKey(feature);
        layer.on("mouseover", () => {
          window.clearTimeout(mapLeaveTimer);
          const rank = feature.properties.journeyRanks.find((value) => cardForRank(value));
          if (rank !== undefined) setHoveredRoute(rank);
        });
        layer.on("mouseout", () => {
          window.clearTimeout(mapLeaveTimer);
          mapLeaveTimer = window.setTimeout(() => setHoveredRoute(null), 100);
        });
        layer.on("click", () => {
          const rank = feature.properties.journeyRanks.find((value) => cardForRank(value));
          const card = cardForRank(rank);
          if (card) {
            setHoveredRoute(rank);
            card.scrollIntoView({ behavior: "smooth", block: window.innerWidth < 1100 ? "start" : "center" });
          }
        });
        const layers = routeLayersByKey.get(key) || {};
        layers.line = layer;
        routeLayersByKey.set(key, layers);
      },
    }).addTo(routeMap);
    warmLogoColors(features);
    if (hoveredJourneyRank !== null) setHoveredRoute(hoveredJourneyRank, true);
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
    if (!mapVisible) return;
    if (routeMap) requestAnimationFrame(() => {
      routeMap.invalidateSize();
      scheduleLabelLayout();
    });
  }

  function mountMapPane() {
    const root = document.querySelector('[data-controller~="filter"]');
    const results = root?.querySelector('#results, [data-filter-target~="elementContainer"]');
    if (!results) return false;
    pageRoot = root;
    if (resultsRoot !== results) {
      resultsRoot?.removeEventListener("mouseleave", leaveResults);
      resultsRoot = results;
      resultsRoot.addEventListener("mouseenter", () => window.clearTimeout(mapLeaveTimer));
      resultsRoot.addEventListener("mouseleave", leaveResults);
    }
    if (mapPane.parentElement !== document.body) document.body.append(mapPane);
    return true;
  }

  function leaveResults() {
    setHoveredRoute(null);
  }

  function closeMapPane() {
    window.clearTimeout(mapLeaveTimer);
    setHoveredRoute(null);
    mapVisible = false;
    mapPane.style.display = "none";
    pageRoot?.classList.remove("railfinder-split-page");
    window.removeEventListener("resize", resizeMapPane);
    cancelQueuedRoutes();
    if (!mapReopenButton) {
      mapReopenButton = document.createElement("button");
      mapReopenButton.id = "railfinder-reopen-button";
      mapReopenButton.type = "button";
      mapReopenButton.textContent = "Open route map";
      mapReopenButton.className = "railfinder-map-button railfinder-reopen-button";
      mapReopenButton.addEventListener("click", openMap);
    }
    if (!mapReopenButton.isConnected) document.body.append(mapReopenButton);
    mapReopenButton.hidden = false;
  }

  function createMapPane() {
    mapPane = document.createElement("section");
    mapPane.id = "railfinder-route-pane";
    mapPane.className = "railfinder-route-pane";
    mapPane.style.display = "none";
    mapPane.style.flexDirection = "column";
    mapPane.setAttribute("aria-label", "Rail route map");

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;font:14px 'Apercu Pro',sans-serif";
    const title = document.createElement("strong");
    title.textContent = "bovine3dom's unofficial route map";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Hide map";
    close.className = "railfinder-map-button";
    toolbar.append(title, close);

    mapContainer = document.createElement("div");
    mapContainer.style.cssText = "flex:1;min-height:0;width:100%;border-radius:12px";
    mapPane.append(toolbar, mapContainer);
    close.addEventListener("click", closeMapPane);
  }

  function openMap() {
    if (!mapPane) createMapPane();
    if (!mountMapPane()) return false;
    mapReopenButton && (mapReopenButton.hidden = true);
    mapAutoStarted = true;
    mapVisible = true;
    pageRoot.classList.add("railfinder-split-page");
    mapPane.style.display = "flex";
    window.addEventListener("resize", resizeMapPane);
    resizeMapPane();
    requestAnimationFrame(() => {
      if (typeof L === "undefined") {
        return;
      }
      if (!routeMap) {
        routeMap = L.map(mapContainer);
        routeMap.on("zoomend", () => window.setTimeout(layoutHoveredLabels, 0));
        routeMap.on("moveend", scheduleLabelLayout);
        routeMap.getPane("tilePane").style.filter = "saturate(0)";
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        }).addTo(routeMap);
        routeMap.attributionControl.addAttribution(
          '© <a href="https://routing.openrailrouting.org/">OpenRailRouting</a>',
        );
        routeMap.setView([51, 7], 5);
      }
      routeMap.invalidateSize();
      scheduleLabelLayout();
      renderMap(true);
    });
    return true;
  }

  function syncSearchPage() {
    const root = document.querySelector('[data-controller~="filter"]');
    const results = root?.querySelector('#results, [data-filter-target~="elementContainer"]');
    if (!results) return;
    if (!mapVisible) {
      if (root.classList.contains("railfinder-split-page")) root.classList.remove("railfinder-split-page");
      if (mapReopenButton && !mapReopenButton.isConnected) document.body.append(mapReopenButton);
      return;
    }
    if (root === pageRoot && results === resultsRoot && mapPane.isConnected) return;
    mountMapPane();
    pageRoot.classList.add("railfinder-split-page");
    pageRoot.querySelectorAll("[data-railfinder-selected]")
      .forEach((card) => card.removeAttribute("data-railfinder-selected"));
    setHoveredRoute(null);
    mapHasFittedData = false;
    requestAnimationFrame(() => {
      if (!mapVisible || !mapPane.isConnected) return;
      routeMap?.invalidateSize();
      renderMap(true);
    });
  }

  document.addEventListener("turbo:before-render", (event) => {
    const newBody = event.detail?.newBody;
    if (!newBody?.querySelector('[data-controller~="filter"]')) return;
    newBody.querySelectorAll("[data-railfinder-selected]")
      .forEach((card) => card.removeAttribute("data-railfinder-selected"));
    for (const element of [mapPane, mapReopenButton]) {
      const copy = element && newBody.querySelector(`#${element.id}`);
      if (copy && copy !== element) copy.remove();
    }
  });
  document.addEventListener("turbo:render", () => {
    rememberCards(document.body);
    syncSearchPage();
  });
  document.addEventListener("turbo:frame-render", (event) => {
    if (event.target.id === "results") {
      setHoveredRoute(null);
      scheduleMapUpdate();
    }
  });

  function scheduleMapUpdate() {
    if (!mapVisible) return;
    window.clearTimeout(mapUpdateTimer);
    mapUpdateTimer = window.setTimeout(() => {
      mapUpdateTimer = null;
      if (mapVisible) renderMap();
    }, 400);
  }

  rememberCards(document.documentElement);

  const observer = new MutationObserver((records) => {
    let routesChanged = false;
    for (const record of records) {
      if (mapPane?.contains(record.target)) continue;
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
    syncSearchPage();
    if (routesChanged) scheduleMapUpdate();
  });

  let mapUpdateTimer;
  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
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
      "class",
      "hidden",
      "style",
    ],
  });
  openMap();
})();
