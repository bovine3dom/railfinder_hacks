// ==UserScript==
// @name         Railfinder route map
// @namespace    railfinder-hacks
// @version      0.18.4
// @author       bovine3dom
// @description  map for railfinder.eu search results
// @match        https://www.railfinder.eu/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js
// @resource     LEAFLET_CSS https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css
// @updateURL    https://raw.githubusercontent.com/bovine3dom/railfinder_hacks/master/src/routemap.user.js
// @downloadURL  https://raw.githubusercontent.com/bovine3dom/railfinder_hacks/master/src/routemap.user.js
// @supportURL   https://github.com/bovine3dom/railfinder_hacks/issues/
// @grant        GM_addStyle
// @grant        GM_getResourceText
// ==/UserScript==

(() => {
  "use strict";

  // {{{ Styles and state
  const LEG_INFO = ".travel-leg-info";
  const TRANSPORT_NAME = ".travel-leg-transport-name";
  const OPEN_RAIL_ROUTING_URL = "https://routing.openrailrouting.org/route";
  const ROUTE_PROFILE = "all_tracks";
  const ROUTE_CACHE_PREFIX = "railfinder.openrailrouting.v2:";
  const ROUTE_MAX_RETRIES = 2;
  const MAX_CONCURRENT_ROUTE_REQUESTS = 3;
  const ROUTE_TIMEOUT_MS = 20000;
  const journeyCards = new Set(), hoverTrackedCards = new WeakSet();
  const logoColorPromises = new Map(), logoColors = new Map();
  const routeGeometryCache = new Map(), displayRouteCache = new Map();
  const pendingRouteRequests = new Map(), routeFailures = new Map(), routeQueue = [];
  let routeDatabasePromise, mapLeaveTimer, selectedCard, resultsRoot, pageRoot;
  let mapReopenButton, mapPane, mapContainer, routeMap, casingLayer, routeLayer, trainLabelLayer;
  let cacheWarningShown = false, activeRouteRequests = 0, routeQueueTimer = null;
  let routeServiceBlockedReason = null, nextRouteRequestAt = 0, routeLayersByKey = new Map();
  let hoveredLabelRecords = [], labelLayoutFrame = 0, hoveredJourneyRank = null;
  let mapVisible = false, mapAutoStarted = false, mapHasFittedData = false;
  let lastRenderedFeatureSignature = null, renderGeneration = 0;

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
  // }}}

  // {{{ Journey data
  function trackCard(card) {
    journeyCards.add(card);
    if (hoverTrackedCards.has(card)) return;
    hoverTrackedCards.add(card);
    card.addEventListener("mouseenter", () => { if (mapVisible) setHoveredRoute(card.dataset.rank); });
  }
  function rememberCards(node) {
    if (!(node instanceof Element)) return;
    if (node.matches("[data-rank]")) trackCard(node);
    node.querySelectorAll("[data-rank]").forEach(trackCard);
  }
  function parsePoint(value) {
    const values = value?.trim().split(/\s+/).map(Number);
    if (values?.length !== 2) return null;
    const [lat, lon] = values;
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      ? [lon, lat] : null;
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
    for (let el = info.parentElement; el && el !== card; el = el.parentElement) {
      if (el.querySelectorAll(LEG_INFO).length === 1 && el.querySelectorAll(TRANSPORT_NAME).length === 1) return el;
    }
    return null;
  }
  function legDuration(info, card) {
    for (let el = info.parentElement; el && el !== card; el = el.parentElement) {
      if (el.querySelectorAll(LEG_INFO).length !== 1 || el.querySelectorAll(TRANSPORT_NAME).length !== 1) continue;
      const seconds = durationIn(el);
      if (seconds !== null) return seconds;
    }
    return null;
  }
  function clockTimes(card) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT), times = [];
    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue.trim();
      if (/^\d{1,2}:\d{2}$/.test(value)) times.push({ node: walker.currentNode, value });
    }
    return times;
  }
  const legTimes = (info, times) => ({
    departureTime: times.findLast(({ node }) =>
      info.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)?.value ?? null,
    arrivalTime: times.find(({ node }) =>
      info.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)?.value ?? null,
  });

  // haversine
  function distanceKm([lon1, latitude1], [lon2, latitude2]) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const lat1 = radians(latitude1), lat2 = radians(latitude2);
    const a = Math.min(1, Math.sin((lat2 - lat1) / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(radians(lon2 - lon1) / 2) ** 2);
    return 12742.0176 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  const cleanText = (value) => (typeof value === "string" ? value : value?.textContent)?.replace(/\s+/g, " ").trim() || null;
  const rankValue = (rank) => Number(rank) || rank;
  const trainName = (transport) => {
    const name = cleanText(transport);
    return name?.split("•").at(-1).trim() || name;
  };
  const operatorFor = (info, card, transport) => {
    const logo = legScope(info, card)?.querySelector("img[alt]");
    return { name: logo?.alt.trim() || cleanText(transport)?.split("•")[0].trim() || null,
      logoUrl: logo?.currentSrc || logo?.src || null };
  };
  function featureFor(card, info, index, transport, times) {
    const from = parsePoint(info.dataset.departurePoint), to = parsePoint(info.dataset.arrivalPoint);
    if (!from || !to) return null;
    const durationSeconds = legDuration(info, card);
    const { departureTime, arrivalTime } = legTimes(info, times);
    const operator = operatorFor(info, card, transport);
    return {
      type: "Feature", geometry: { type: "LineString", coordinates: [from, to] },
      properties: {
        journeyRank: rankValue(card.dataset.rank), legIndex: index,
        from: info.dataset.departureStationName || null, to: info.dataset.arrivalStationName || null,
        fromStationId: info.dataset.departureStation || null, toStationId: info.dataset.arrivalStation || null,
        transport: cleanText(transport), departureTime, arrivalTime,
        operator: operator.name, operatorLogoUrl: operator.logoUrl,
        straightLineAverageSpeedKmh: durationSeconds
          ? Number((distanceKm(from, to) / (durationSeconds / 3600)).toFixed(1)) : null,
      },
    };
  }

  function currentFeatures(rank = null) {
    const features = [];
    for (const card of journeyCards) {
      if (!card.isConnected) { journeyCards.delete(card); continue; }
      if ((rank !== null && rankValue(card.dataset.rank) !== rank) || !card.getClientRects().length) continue;
      const infos = card.querySelectorAll(LEG_INFO);
      if (!infos.length) continue;
      const transports = card.querySelectorAll(TRANSPORT_NAME), times = clockTimes(card);
      infos.forEach((info, index) => {
        const feature = featureFor(card, info, index, transports[index], times);
        if (feature) features.push(feature);
      });
    }
    return features;
  }
  const stationPairKey = ({ properties: p }) => JSON.stringify([
    p.fromStationId || p.from, p.toStationId || p.to,
  ].sort());

  // group routes by station pair,  aggregate count for line width, max speed for colour without hover
  function consolidateByStationPair(features) {
    const pairs = new Map();
    for (const feature of features) {
      const p = feature.properties, key = stationPairKey(feature);
      let pair = pairs.get(key);
      if (!pair) {
        pair = { type: "Feature", geometry: feature.geometry, properties: {
          from: p.from, to: p.to, fromStationId: p.fromStationId, toStationId: p.toStationId,
          maxStraightLineAverageSpeedKmh: null, routeKey: railRouteKey(feature), routeEnds: routeEnds(feature),
          journeyRanks: new Set(), operatorsByJourney: [],
        } };
        pairs.set(key, pair);
      }
      const properties = pair.properties, ranks = properties.journeyRanks;
      if (!ranks.has(p.journeyRank)) {
        ranks.add(p.journeyRank);
        properties.operatorsByJourney.push({
          journeyRank: p.journeyRank, operator: p.operator, operatorLogoUrl: p.operatorLogoUrl,
          trainName: trainName(p.transport), departureTime: p.departureTime, arrivalTime: p.arrivalTime,
        });
      }
      const speed = p.straightLineAverageSpeedKmh;
      if (speed !== null && (properties.maxStraightLineAverageSpeedKmh === null
        || speed > properties.maxStraightLineAverageSpeedKmh)) properties.maxStraightLineAverageSpeedKmh = speed;
    }
    return pairs.values().map((pair) => {
      const ranks = [...pair.properties.journeyRanks];
      pair.properties.count = ranks.length;
      pair.properties.journeyRanks = ranks;
      return pair;
    }).toArray();
  }
  // }}}

  // {{{ Operator colours
  function operatorFallbackColor(name) {
    let hash = 0;
    for (const character of name || "unknown") hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return `hsl(${(hash >>> 0) % 360}, 70%, 40%)`;
  }

  // work out what to colour the routes by peeking at the operator logos
  function dominantLogoColor(image) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data, colors = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const red = pixels[i], green = pixels[i + 1], blue = pixels[i + 2];
      if (pixels[i + 3] < 128 || (red > 235 && green > 235 && blue > 235)) continue;
      const key = `${red >> 4},${green >> 4},${blue >> 4}`;
      const color = colors.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      color.count++; color.red += red; color.green += green; color.blue += blue;
      colors.set(key, color);
    }
    const dominant = colors.values().reduce((best, color) => color.count > (best?.count ?? 0) ? color : best, null);
    if (!dominant) return null;
    return `rgb(${Math.round(dominant.red / dominant.count)},${Math.round(dominant.green / dominant.count)},${Math.round(dominant.blue / dominant.count)})`;
  }

  function loadLogoColor(url) {
    if (!url) return Promise.resolve(null);
    if (logoColorPromises.has(url)) return logoColorPromises.get(url);
    let source;
    try { source = new URL(url, location.href); } catch { return Promise.resolve(null); }
    const promise = new Promise((resolve) => {
      const image = document.createElement("img");
      if (source.origin !== location.origin) image.crossOrigin = "anonymous";
      const readColor = () => {
        try { resolve(dominantLogoColor(image)); } catch { resolve(null); }
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
    const urls = new Set(features.flatMap(({ properties: p }) => [
      p.operatorLogoUrl, ...(p.operatorsByJourney?.map(({ operatorLogoUrl }) => operatorLogoUrl) || []),
    ]).filter(Boolean));
    const layer = routeLayer;
    Promise.all(urls.values().map(loadLogoColor)).then(() => {
      if (routeLayer !== layer || !mapVisible) return;
      routeLayer.setStyle(featureStyle);
      if (hoveredJourneyRank !== null) setHoveredRoute(hoveredJourneyRank, true);
    });
  }

  // }}}

  // {{{ Route cache
  const routeEnds = ({ properties: p, geometry: { coordinates: coords } }) => p.routeEnds
    || (p.fromStationId && p.toStationId ? [p.fromStationId, p.toStationId] : [coords[0], coords.at(-1)]);
  function routeIsReversed(feature) {
    const [from, to] = routeEnds(feature);
    return JSON.stringify(from) > JSON.stringify(to);
  }
  function railRouteKey(feature) {
    if (feature.properties.routeKey) return feature.properties.routeKey;
    const ends = [...routeEnds(feature)];
    if (routeIsReversed(feature)) ends.reverse();
    return ROUTE_CACHE_PREFIX + encodeURIComponent(JSON.stringify([ROUTE_PROFILE, ends]));
  }
  const orientRoute = (feature, coordinates) => routeIsReversed(feature) ? coordinates.toReversed() : coordinates;
  const validRouteCoordinates = (coords) => Array.isArray(coords) && coords.length >= 2
    && coords.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0])
      && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
  function displayRouteCoordinates(feature, coordinates) {
    const key = railRouteKey(feature) + (routeIsReversed(feature) ? ":reverse" : ":forward");
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

  function routeDatabase() {
    routeDatabasePromise ??= new Promise((resolve) => {
      let request;
      try { request = indexedDB.open("railfinder-hacks-openrailrouting", 1); }
      catch { resolve(null); return; }
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore("routes");
      request.onerror = () => resolve(null);
      request.onblocked = () => { blocked = true; resolve(null); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) return db.close();
        db.onversionchange = () => { db.close(); routeDatabasePromise = null; };
        resolve(db);
      };
    });
    return routeDatabasePromise;
  }

  async function databaseRouteCoordinates(db, key) {
    if (!db) return null;
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("routes").objectStore("routes").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  }
  async function storedRouteCoordinates(key, feature) {
    if (!routeGeometryCache.has(key)) {
      const db = await routeDatabase();
      let coordinates = await databaseRouteCoordinates(db, key);
      if (!validRouteCoordinates(coordinates)) {
        try { coordinates = JSON.parse(localStorage.getItem(key)); } catch { /* Storage can be blocked. */ }
        if (!validRouteCoordinates(coordinates)) return null;
        if (db) await storeRouteCoordinates(key, coordinates);
      }
      routeGeometryCache.set(key, coordinates);
    }
    return orientRoute(feature, routeGeometryCache.get(key));
  }
  async function storeRouteCoordinates(key, coordinates) {
    routeGeometryCache.set(key, coordinates);
    const db = await routeDatabase();
    if (db) {
      try {
        const saved = await new Promise((resolve) => {
          const transaction = db.transaction("routes", "readwrite");
          transaction.oncomplete = () => resolve(true);
          transaction.onerror = transaction.onabort = () => resolve(false);
          transaction.objectStore("routes").put(coordinates, key);
        });
        if (saved) return true;
      } catch {
        // Fall back to local storage if the database cannot accept writes.
      }
    }
    try { localStorage.setItem(key, JSON.stringify(coordinates)); return true; }
    catch {
      if (!cacheWarningShown) {
        console.warn("Railfinder route map: Route storage is unavailable; routes may be fetched again.");
        cacheWarningShown = true;
      }
      return false;
    }
  }
  // }}}

  // {{{ Route requests
  function retryAfterMilliseconds(response) {
    const value = response.headers.get("Retry-After");
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
    const reset = response.headers.get("RateLimit-Reset") || response.headers.get("X-RateLimit-Reset");
    if (reset === null) return null;
    const number = Number(reset);
    if (Number.isFinite(number)) return Math.max(0, number > 1e9 ? number * 1000 - Date.now() : number * 1000);
    const date = Date.parse(reset);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
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
    const coords = feature.geometry.coordinates, from = coords[0], to = coords.at(-1);
    const url = new URL(OPEN_RAIL_ROUTING_URL);
    for (const [lon, lat] of [from, to]) url.searchParams.append("point", `${lat},${lon}`);
    url.searchParams.set("profile", ROUTE_PROFILE);
    url.searchParams.set("instructions", "false");
    url.searchParams.set("points_encoded", "false");
    for (let attempt = 0; attempt <= ROUTE_MAX_RETRIES; attempt += 1) {
      await waitUntil(nextRouteRequestAt);
      let response;
      try {
        response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS) });
        if (/text\/html/i.test(response.headers.get("Content-Type") || "")) {
          routeServiceBlockedReason = "challenge page returned"; return null;
        }
        if ([401, 403, 404, 501].includes(response.status)) {
          routeServiceBlockedReason = response.status === 501
            ? "requested profile unsupported" : "authentication, endpoint, or access denied";
          return null;
        }
        if (response.ok) {
          const data = await response.json(), points = data.paths?.[0]?.points;
          const coordinates = points?.coordinates || points;
          if (!Array.isArray(coordinates)) {
            if (data.paths?.length) routeServiceBlockedReason = "unexpected geometry format";
            return null;
          }
          return validRouteCoordinates(coordinates) ? coordinates.map(([lon, lat]) => [lon, lat]) : null;
        }
      } catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) {
          routeServiceBlockedReason = error instanceof TypeError
            ? "CORS or network error" : "invalid response (possibly a challenge)";
          return null;
        }
        const delay = 1500 * 2 ** attempt + Math.random() * 500;
        nextRouteRequestAt = Math.max(nextRouteRequestAt, Date.now() + delay);
        if (attempt === ROUTE_MAX_RETRIES) return null;
        continue;
      }
      const retryAfter = retryAfterMilliseconds(response);
      if (retryAfter !== null) nextRouteRequestAt = Math.max(nextRouteRequestAt, Date.now() + retryAfter);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === ROUTE_MAX_RETRIES) return null;
      const backoff = retryAfter ?? (response.status === 429 ? 30000 : 5000) * 2 ** attempt;
      nextRouteRequestAt = Math.max(nextRouteRequestAt, Date.now() + backoff);
    }
    return null;
  }

  function processRouteQueue() {
    if (routeServiceBlockedReason) return cancelQueuedRoutes();
    if (!routeQueue.length || activeRouteRequests >= MAX_CONCURRENT_ROUTE_REQUESTS) return;
    const delay = nextRouteRequestAt - Date.now();
    if (delay > 0) {
      if (!routeQueueTimer) routeQueueTimer = window.setTimeout(() => {
        routeQueueTimer = null; processRouteQueue();
      }, delay);
      return;
    }
    routeQueue.sort((a, b) => b.priority - a.priority);
    while (routeQueue.length && activeRouteRequests < MAX_CONCURRENT_ROUTE_REQUESTS) {
      const job = routeQueue.shift();
      activeRouteRequests++;
      fetchRailRoute(job.feature).then(async (coordinates) => {
        if (coordinates) {
          await storeRouteCoordinates(job.key, orientRoute(job.feature, coordinates));
          routeFailures.delete(job.key);
        } else routeFailures.set(job.key, Date.now() + 10 * 60 * 1000);
        job.resolve(coordinates);
      }).catch(() => {
        routeFailures.set(job.key, Date.now() + 10 * 60 * 1000);
        job.resolve(null);
      }).finally(() => {
        activeRouteRequests--;
        if (routeServiceBlockedReason) cancelQueuedRoutes();
        processRouteQueue();
      });
    }
  }

  function requestRailRoute(feature) {
    if (routeServiceBlockedReason) return;
    const key = railRouteKey(feature);
    if (pendingRouteRequests.has(key) || (routeFailures.get(key) || 0) > Date.now()) return;
    const { promise, resolve } = Promise.withResolvers();
    const [from, to] = feature.geometry.coordinates;
    routeQueue.push({ key, feature, resolve, priority: feature.properties.count * distanceKm(from, to) });
    pendingRouteRequests.set(key, promise);
    promise.then((coordinates) => {
      const layer = routeLayersByKey.get(key);
      if (!coordinates || !layer || !mapVisible) return;
      const directed = orientRoute(layer.line.feature, routeGeometryCache.get(key));
      const display = displayRouteCoordinates(layer.line.feature, directed);
      const latLngs = display.map(([lon, lat]) => [lat, lon]);
      for (const route of [layer.line, layer.casing]) {
        route.feature.geometry.coordinates = display;
        route.setLatLngs(latLngs);
      }
      if (hoveredJourneyRank !== null && layer.line.feature.properties.journeyRanks?.includes(hoveredJourneyRank)) {
        renderHoveredTrainLabels();
      }
    }).finally(() => pendingRouteRequests.delete(key));
    return promise;
  }

  function cancelQueuedRoutes() {
    if (routeQueueTimer) window.clearTimeout(routeQueueTimer);
    routeQueueTimer = null;
    for (const job of routeQueue.splice(0)) job.resolve(null);
  }
  // }}}

  // {{{ Map styles
  const lineWeight = (feature, selected = false) => selected ? 3 : Math.min(12, 2 + feature.properties.count);
  const isHoveredFeature = (feature) => feature.properties.journeyRanks.includes(hoveredJourneyRank);
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
  // }}}

  // {{{ Map labels
  const setLabelOffset = (element, [x, y]) => {
    element.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
  };
  function layoutHoveredLabels() {
    if (!trainLabelLayer) return;
    const viewport = mapContainer.getBoundingClientRect();
    const labels = hoveredLabelRecords.map((label) => ({ ...label, rect: label.element.getBoundingClientRect() }));
    const placed = [], moves = [];
    for (const label of labels) {
      const { element, offsets, currentOffset, rect } = label;
      if (rect.right < viewport.left || rect.left > viewport.right
        || rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      let bestOffset, bestRect;
      const place = (offset) => {
        const dx = offset[0] - currentOffset[0], dy = offset[1] - currentOffset[1];
        const candidate = {
          left: rect.left + dx, right: rect.right + dx,
          top: rect.top + dy, bottom: rect.bottom + dy,
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
        for (let step = 1; step <= steps; step++) {
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
      if (bestOffset) { setLabelOffset(element, bestOffset); label.currentOffset = bestOffset; }
    }
  }

  function scheduleLabelLayout() {
    if (!trainLabelLayer || labelLayoutFrame) return;
    labelLayoutFrame = requestAnimationFrame(() => { labelLayoutFrame = 0; layoutHoveredLabels(); });
  }
  function renderHoveredTrainLabels() {
    if (trainLabelLayer) routeMap.removeLayer(trainLabelLayer);
    trainLabelLayer = null; hoveredLabelRecords = [];
    if (!routeMap || !routeLayer || hoveredJourneyRank === null) return;
    const font = getComputedStyle(document.querySelector(TRANSPORT_NAME) || pageRoot || document.body);
    const labels = L.layerGroup();
    const addLabel = (value, point, color, offsets, multiline = false) => {
      if (!value || !point) return;
      const text = document.createElement("span");
      text.className = "railfinder-map-label"; text.textContent = value;
      text.style.fontFamily = font.fontFamily; text.style.fontSize = font.fontSize;
      text.style.fontWeight = font.fontWeight; text.style.color = color;
      text.style.textAlign = "center"; text.style.whiteSpace = multiline ? "pre" : "nowrap";
      setLabelOffset(text, offsets[0]);
      const icon = L.divIcon({ className: "railfinder-train-label-icon", html: text,
        iconSize: [1, 1], iconAnchor: [0, 0] });
      labels.addLayer(L.marker(point, { icon, interactive: false, keyboard: false }));
      hoveredLabelRecords.push({ element: text, offsets, currentOffset: offsets[0] });
    };
    const addStationLabel = (name, point, times) => {
      if (!name) return;
      const timeText = times.filter(Boolean).join(" ");
      addLabel(`${name}${timeText ? `\n${timeText}` : ""}`, point, "#172554",
        [[0, -24], [0, -44], [24, -24], [-24, -24], [24, 24], [-24, 24], [0, 44]], Boolean(timeText));
    };
    routeLayer.eachLayer((layer) => {
      const feature = layer.feature;
      if (!isHoveredFeature(feature)) return;
      const journey = feature.properties.operatorsByJourney?.find((entry) => entry.journeyRank === hoveredJourneyRank);
      if (!journey?.trainName) return;
      const points = layer.getLatLngs(), middle = Math.floor(points.length / 2);
      const point = points[middle];
      if (!point) return;
      const before = routeMap.latLngToLayerPoint(points[Math.max(0, middle - 1)]);
      const after = routeMap.latLngToLayerPoint(points[Math.min(points.length - 1, middle + 1)]);
      const dx = after.x - before.x, dy = after.y - before.y;
      const length = Math.hypot(dx, dy) || 1, side = hoveredJourneyRank % 2 ? 1 : -1;
      const nx = -dy / length * side, ny = dx / length * side;
      const offsets = [16, 32, 48].map((distance) => [nx * distance, ny * distance]);
      for (const shift of [-48, -24, 24, 48]) offsets.push([
        nx * 16 + dx / length * shift, ny * 16 + dy / length * shift,
      ]);
      addLabel(journey.trainName, point, featureStyle(feature).color, offsets);
    });

    const legs = currentFeatures(hoveredJourneyRank).sort((a, b) => a.properties.legIndex - b.properties.legIndex);
    if (legs.length) {
      [[legs[0], 0, "from", "departureTime", "dep"],
        [legs.at(-1), -1, "to", "arrivalTime", "arr"]].forEach(([leg, end, name, time, label]) => {
        const [lon, lat] = leg.geometry.coordinates.at(end);
        addStationLabel(leg.properties[name], L.latLng(lat, lon), [
          leg.properties[time] && `${label}: ${leg.properties[time]}`]);
      });
    }
    for (let index = 0; index < legs.length - 1; index += 1) {
      const leg = legs[index], next = legs[index + 1];
      const sameStation = (leg.properties.toStationId && next.properties.fromStationId
        && leg.properties.toStationId === next.properties.fromStationId) || leg.properties.to === next.properties.from;
      const stationName = sameStation ? leg.properties.to : [leg.properties.to, next.properties.from].filter(Boolean).join(" → ");
      if (!stationName) continue;
      const [lon, lat] = leg.geometry.coordinates.at(-1);
      addStationLabel(stationName, L.latLng(lat, lon), [
        leg.properties.arrivalTime && `arr: ${leg.properties.arrivalTime}`,
        next.properties.departureTime && `dep: ${next.properties.departureTime}`]);
    }
    if (labels.getLayers().length) { trainLabelLayer = labels.addTo(routeMap); layoutHoveredLabels(); }
  }
  // }}}

  // {{{ Route selection and map drawing
  const cardForRank = (r) => journeyCards.values().find((c) => c.isConnected && rankValue(c.dataset.rank) === r && c.getClientRects().length) || null;
  function setHoveredRoute(rank, force = false) {
    const nextRank = rank === null ? null : rankValue(rank);
    if (!force && hoveredJourneyRank === nextRank) return;
    hoveredJourneyRank = nextRank;
    selectedCard?.removeAttribute("data-railfinder-selected");
    selectedCard = cardForRank(nextRank);
    selectedCard?.setAttribute("data-railfinder-selected", "");
    if (!routeLayer) return renderHoveredTrainLabels();
    routeLayer.setStyle(featureStyle);
    casingLayer?.setStyle(casingStyle);
    routeLayer.eachLayer((layer) => { if (isHoveredFeature(layer.feature)) layer.bringToFront(); });
    renderHoveredTrainLabels();
  }

  async function renderMap(forceFit = false) {
    if (!routeMap) return;
    const generation = ++renderGeneration;
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
    const cached = await Promise.all(features.map((feature) => storedRouteCoordinates(railRouteKey(feature), feature)));
    if (generation !== renderGeneration || !mapVisible) return;
    lastRenderedFeatureSignature = signature;
    if (casingLayer) routeMap.removeLayer(casingLayer);
    if (routeLayer) routeMap.removeLayer(routeLayer);
    casingLayer = routeLayer = null;
    renderHoveredTrainLabels();
    routeLayersByKey = new Map();
    features.forEach((feature, index) => {
      if (cached[index]) feature.geometry.coordinates = displayRouteCoordinates(feature, cached[index]);
    });
    if (!features.length) return;

    const collection = { type: "FeatureCollection", features };
    casingLayer = L.geoJSON(collection, {
      style: casingStyle, smoothFactor: 3, interactive: false,
      onEachFeature: (feature, layer) => routeLayersByKey.set(railRouteKey(feature), { casing: layer }),
    }).addTo(routeMap);
    routeLayer = L.geoJSON(collection, {
      style: featureStyle, smoothFactor: 3,
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
    features.forEach((feature, index) => { if (!cached[index]) requestRailRoute(feature); });
    processRouteQueue();
    const bounds = routeLayer.getBounds();
    if (bounds.isValid() && (forceFit || !mapHasFittedData)) {
      routeMap.fitBounds(bounds.pad(0.1), { maxZoom: 9 });
      mapHasFittedData = true;
    }
  }
  // }}}

  // {{{ Map pane and Turbo lifecycle
  function resizeMapPane() {
    if (mapVisible && routeMap) requestAnimationFrame(() => { routeMap.invalidateSize(); scheduleLabelLayout(); });
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

  const leaveResults = () => setHoveredRoute(null);
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
      mapReopenButton.id = "railfinder-reopen-button"; mapReopenButton.type = "button";
      mapReopenButton.textContent = "Open route map";
      mapReopenButton.className = "railfinder-map-button railfinder-reopen-button";
      mapReopenButton.addEventListener("click", openMap);
    }
    if (!mapReopenButton.isConnected) document.body.append(mapReopenButton);
    mapReopenButton.hidden = false;
  }

  function createMapPane() {
    mapPane = document.createElement("section");
    mapPane.id = "railfinder-route-pane"; mapPane.className = "railfinder-route-pane";
    mapPane.style.display = "none"; mapPane.style.flexDirection = "column";
    mapPane.setAttribute("aria-label", "Rail route map");
    const toolbar = document.createElement("div"), title = document.createElement("strong");
    toolbar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;font:14px 'Apercu Pro',sans-serif";
    title.textContent = "bovine3dom's unofficial route map";
    const close = document.createElement("button");
    close.type = "button"; close.textContent = "Hide map"; close.className = "railfinder-map-button";
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
      if (typeof L === "undefined") return;
      if (!routeMap) {
        routeMap = L.map(mapContainer);
        routeMap.on("zoomend", () => window.setTimeout(layoutHoveredLabels, 0));
        routeMap.on("moveend", scheduleLabelLayout);
        routeMap.getPane("tilePane").style.filter = "saturate(0)";
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        }).addTo(routeMap);
        routeMap.attributionControl.addAttribution('© <a href="https://routing.openrailrouting.org/">OpenRailRouting</a>');
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
    pageRoot.querySelectorAll("[data-railfinder-selected]").forEach((card) => card.removeAttribute("data-railfinder-selected"));
    setHoveredRoute(null);
    mapHasFittedData = false;
    requestAnimationFrame(() => {
      if (!mapVisible || !mapPane.isConnected) return;
      routeMap?.invalidateSize();
      renderMap(true);
    });
  }

  // re-attach ourselves after server-side rendering updates the page
  document.addEventListener("turbo:before-render", (event) => {
    const newBody = event.detail?.newBody;
    if (!newBody?.querySelector('[data-controller~="filter"]')) return;
    newBody.querySelectorAll("[data-railfinder-selected]").forEach((card) => card.removeAttribute("data-railfinder-selected"));
    for (const element of [mapPane, mapReopenButton]) {
      const copy = element && newBody.querySelector(`#${element.id}`);
      if (copy && copy !== element) copy.remove();
    }
  });
  document.addEventListener("turbo:render", () => { rememberCards(document.body); syncSearchPage(); });
  document.addEventListener("turbo:frame-render", (event) => {
    if (event.target.id === "results") { setHoveredRoute(null); scheduleMapUpdate(); }
  });
  function scheduleMapUpdate() {
    if (!mapVisible) return;
    window.clearTimeout(mapUpdateTimer);
    mapUpdateTimer = window.setTimeout(() => { mapUpdateTimer = null; if (mapVisible) renderMap(); }, 400);
  }
  rememberCards(document.documentElement);

  // update the map as the results load
  const observer = new MutationObserver((records) => {
    let routesChanged = false;
    for (const record of records) {
      if (mapPane?.contains(record.target)) continue;
      if (record.type === "attributes") {
        const card = record.target.matches("[data-rank]") ? record.target : record.target.closest("[data-rank]");
        if (card) { rememberCards(card); routesChanged = true; }
        continue;
      }

      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      const targetCard = target?.closest("[data-rank]");
      if (targetCard && journeyCards.has(targetCard)) routesChanged = true;
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches("[data-rank]") || node.querySelector("[data-rank]"))) routesChanged = true;
        rememberCards(node);
      }
    }
    if (!mapAutoStarted && document.querySelector('[data-controller~="filter"]')) openMap();
    syncSearchPage();
    if (routesChanged) scheduleMapUpdate();
  });

  let mapUpdateTimer;
  observer.observe(document.documentElement, {
    childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: [
      "data-rank", "data-departure-station", "data-departure-station-name", "data-departure-point",
      "data-arrival-station", "data-arrival-station-name", "data-arrival-point",
      "src", "srcset", "alt", "class", "hidden", "style",
    ],
  });
  openMap();
  // }}}
})();
// vim: set foldmethod=marker foldlevel=0 :
