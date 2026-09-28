// ==UserScript==
// @name         Railfinder route GeoJSON
// @namespace    railfinder-hacks
// @version      0.3.0
// @description  Map and copy Railfinder journey legs.
// @match        https://www.railfinder.eu/search*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js
// @resource     LEAFLET_CSS https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// ==/UserScript==

(() => {
  "use strict";

  const PANEL_ID = "railfinder-controls";
  const LEG_INFO = ".travel-leg-info";
  const TRANSPORT_NAME = ".travel-leg-transport-name";
  const MAX_CURVE_FRACTION = 0.12;
  const journeyCards = new Set();
  const hoverTrackedCards = new WeakSet();
  let resultsRoot;
  let originalResultsStyle;
  let originalBodyOverflow;
  let mapPane;
  let mapContainer;
  let mapMode;
  let mapStatus;
  let routeMap;
  let routeLayer;
  let hoveredJourneyRank = null;
  let mapVisible = false;

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

  function legDuration(info, card) {
    // Find the closest container that holds this leg's info and transport name.
    for (let element = info.parentElement; element && element !== card; element = element.parentElement) {
      if (element.querySelectorAll(LEG_INFO).length !== 1) continue;
      if (element.querySelectorAll(TRANSPORT_NAME).length !== 1) continue;
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

  function featureFor(card, info, index, transport) {
    const from = parsePoint(info.dataset.departurePoint);
    const to = parsePoint(info.dataset.arrivalPoint);
    if (!from || !to) return null;

    const durationSeconds = legDuration(info, card);
    const straightLineDistanceKm = distanceKm(from, to);
    const properties = {
      journeyRank: rankValue(card.dataset.rank),
      leg: index + 1,
      from: info.dataset.departureStationName || null,
      to: info.dataset.arrivalStationName || null,
      fromStationId: info.dataset.departureStation || null,
      toStationId: info.dataset.arrivalStation || null,
      transport: cleanText(transport),
      durationSeconds,
      straightLineDistanceKm: Number(straightLineDistanceKm.toFixed(2)),
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

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Clipboard access was blocked.");
    }
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
              legOccurrences: 0,
              maxStraightLineAverageSpeedKmh: null,
              maxSpeedDurationSeconds: null,
              maxSpeedJourneyRank: null,
              maxSpeedLeg: null,
              maxSpeedTransport: null,
            },
          },
          journeyRanks: new Set(),
        };
        pairs.set(key, pair);
      }

      const properties = pair.feature.properties;
      properties.legOccurrences += 1;
      pair.journeyRanks.add(p.journeyRank);
      const speed = p.straightLineAverageSpeedKmh;
      if (speed !== null && (properties.maxStraightLineAverageSpeedKmh === null
        || speed > properties.maxStraightLineAverageSpeedKmh)) {
        properties.maxStraightLineAverageSpeedKmh = speed;
        properties.maxSpeedDurationSeconds = p.durationSeconds;
        properties.maxSpeedJourneyRank = p.journeyRank;
        properties.maxSpeedLeg = p.leg;
        properties.maxSpeedTransport = p.transport;
      }
    }
    return [...pairs.values()].map(({ feature, journeyRanks }) => {
      feature.properties.count = journeyRanks.size;
      feature.properties.journeyRanks = [...journeyRanks];
      feature.properties.logCount = Math.log10(feature.properties.count) + 1;
      return feature;
    });
  }

  async function copyGeoJSON(button, features, successText) {
    if (!features.length) {
      button.textContent = "No journey legs found";
      return;
    }

    try {
      await copyText(JSON.stringify({ type: "FeatureCollection", features }, null, 2));
      button.textContent = successText;
    } catch (error) {
      button.textContent = "Copy failed — check permissions";
      console.error("Railfinder GeoJSON copy failed:", error);
    }
    window.setTimeout(() => { button.textContent = button.dataset.label; }, 2500);
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return "unknown";
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  }

  function makePopup(feature) {
    const p = feature.properties;
    const content = document.createElement("div");
    const rows = [
      ["From", p.from],
      ["To", p.to],
      ["Count", p.count],
      ["Leg duration", formatDuration(p.maxSpeedDurationSeconds ?? p.durationSeconds)],
      ["Max straight-line speed", p.maxStraightLineAverageSpeedKmh ?? p.straightLineAverageSpeedKmh],
      ["Transport", p.maxSpeedTransport ?? p.transport],
    ];
    if (p.journeyRank !== undefined) rows.push(["Journey", p.journeyRank], ["Leg", p.leg]);
    for (const [label, value] of rows) {
      if (value === undefined || value === null) continue;
      const row = document.createElement("div");
      row.textContent = `${label}: ${value}${label.includes("speed") ? " km/h" : ""}`;
      content.append(row);
    }
    return content;
  }

  function curvedLeg(feature, offsetFraction) {
    const [[fromLon, fromLat], [toLon, toLat]] = feature.geometry.coordinates;
    const radius = 6378137;
    const toRadians = Math.PI / 180;
    const project = ([lon, lat]) => [
      radius * lon * toRadians,
      radius * Math.log(Math.tan(Math.PI / 4 + lat * toRadians / 2)),
    ];
    const unproject = ([x, y]) => [
      x / radius / toRadians,
      (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) / toRadians,
    ];
    const start = project([fromLon, fromLat]);
    const end = project([toLon, toLat]);
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (!length) return feature;

    const offset = length * offsetFraction;
    const control = [
      (start[0] + end[0]) / 2 - dy / length * offset,
      (start[1] + end[1]) / 2 + dx / length * offset,
    ];
    const coordinates = Array.from({ length: 17 }, (_, index) => {
      const t = index / 16;
      const inverse = 1 - t;
      return unproject([
        inverse ** 2 * start[0] + 2 * inverse * t * control[0] + t ** 2 * end[0],
        inverse ** 2 * start[1] + 2 * inverse * t * control[1] + t ** 2 * end[1],
      ]);
    });
    return { ...feature, geometry: { ...feature.geometry, coordinates } };
  }

  function curveLegs(features) {
    const groups = new Map();
    for (const feature of features) {
      const key = stationPairKey(feature);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(feature);
    }

    const curved = [];
    for (const group of groups.values()) {
      group.sort((a, b) => {
        const speedA = a.properties.straightLineAverageSpeedKmh ?? -Infinity;
        const speedB = b.properties.straightLineAverageSpeedKmh ?? -Infinity;
        return speedB - speedA
          || Number(a.properties.journeyRank) - Number(b.properties.journeyRank)
          || a.properties.leg - b.properties.leg;
      });
      group.forEach((feature, index) => {
        if (group.length === 1) curved.push(feature);
        else {
          const rank = index + 1;
          const side = rank % 2 ? 1 : -1;
          curved.push(curvedLeg(feature, side * MAX_CURVE_FRACTION * rank / group.length));
        }
      });
    }
    return curved;
  }

  function featureStyle(feature) {
    const p = feature.properties;
    const speed = p.maxStraightLineAverageSpeedKmh ?? p.straightLineAverageSpeedKmh;
    const weight = p.count === undefined ? 3 : Math.min(12, 2 + p.count);
    const color = speed >= 100 ? "#dc2626" : speed >= 60 ? "#ea580c" : "#2563eb";
    const selected = p.journeyRank === hoveredJourneyRank
      || p.journeyRanks?.includes(hoveredJourneyRank);
    if (hoveredJourneyRank === null) return { color, weight, opacity: 0.8 };
    return selected
      ? { color: "#e11d48", weight: weight + 3, opacity: 1 }
      : { color, weight, opacity: 0.12 };
  }

  function setHoveredRoute(rank) {
    hoveredJourneyRank = rank === null ? null : rankValue(rank);
    if (!routeLayer) return;
    routeLayer.eachLayer((layer) => {
      layer.setStyle(featureStyle(layer.feature));
      const p = layer.feature.properties;
      if (p.journeyRank === hoveredJourneyRank || p.journeyRanks?.includes(hoveredJourneyRank)) {
        layer.bringToFront();
      }
    });
  }

  function renderMap() {
    if (!routeMap) return;
    if (routeLayer) routeMap.removeLayer(routeLayer);
    routeLayer = null;

    const legs = currentFeatures();
    const pairsMode = mapMode.value === "pairs";
    const features = pairsMode
      ? consolidateByStationPair(legs)
      : curveLegs(legs);
    mapStatus.textContent = features.length
      ? pairsMode
        ? `Showing ${features.length} station pairs. Hover a result to highlight its pairs.`
        : `Showing ${features.length} legs. Hover a result to highlight it; curves are visual only.`
      : "No route legs are available.";
    if (!features.length) return;

    routeLayer = L.geoJSON({ type: "FeatureCollection", features }, {
      style: featureStyle,
      onEachFeature: (feature, layer) => layer.bindPopup(makePopup(feature)),
    }).addTo(routeMap);
    if (hoveredJourneyRank !== null) setHoveredRoute(hoveredJourneyRank);

    const bounds = routeLayer.getBounds();
    if (bounds.isValid()) routeMap.fitBounds(bounds.pad(0.1), { maxZoom: 9 });
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
    resultsRoot = card?.closest('[data-controller~="filter"]');
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
    const controls = document.getElementById(PANEL_ID);
    if (controls) controls.style.display = "flex";
  }

  function createMapPane() {
    mapPane = document.createElement("section");
    mapPane.style.cssText = "position:fixed;display:none;flex-direction:column;min-width:0;box-sizing:border-box;padding:12px;background:white;box-shadow:0 2px 10px #0002";
    mapPane.setAttribute("aria-label", "Rail route map");

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;font:14px sans-serif";
    const title = document.createElement("strong");
    title.textContent = "Railfinder routes";
    mapMode = document.createElement("select");
    mapMode.setAttribute("aria-label", "Map data");
    mapMode.innerHTML = '<option value="pairs">Station pairs (max speed)</option><option value="legs">All journey legs</option>';
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close map";
    mapStatus = document.createElement("span");
    mapStatus.style.cssText = "flex:1 1 100%;color:#475569";
    for (const button of [refresh, close]) {
      button.style.cssText = "padding:6px 10px;border:1px solid #94a3b8;border-radius:4px;background:white;cursor:pointer";
    }
    toolbar.append(title, mapMode, refresh, close, mapStatus);

    mapContainer = document.createElement("div");
    mapContainer.style.cssText = "flex:1;min-height:0;width:100%;border-radius:4px";
    mapPane.append(toolbar, mapContainer);
    mapMode.addEventListener("change", renderMap);
    refresh.addEventListener("click", renderMap);
    close.addEventListener("click", closeMapPane);
  }

  function openMap() {
    if (!mapPane) createMapPane();
    if (!mountMapPane()) return;
    mapVisible = true;
    mapPane.style.display = "flex";
    document.body.style.overflow = "hidden";
    window.addEventListener("resize", resizeMapPane);
    const controls = document.getElementById(PANEL_ID);
    if (controls) controls.style.display = "none";
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
        routeMap.setView([51, 7], 5);
      }
      routeMap.invalidateSize();
      renderMap();
    });
  }

  function addButton() {
    if (document.getElementById(PANEL_ID) || !currentFeatures().length) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px";

    const makeButton = (label, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.label = label;
      button.textContent = label;
      button.style.cssText = [
        "padding:10px 14px", "border:0", "border-radius:6px", "background:#164e63",
        "color:white", "font:600 14px sans-serif", "cursor:pointer",
        "box-shadow:0 2px 8px #0004",
      ].join(";");
      button.addEventListener("click", () => action(button));
      return button;
    };

    panel.append(
      makeButton("Copy all routes as GeoJSON", (button) => {
        const legs = currentFeatures();
        const routes = new Set(legs.map(({ properties }) => properties.journeyRank)).size;
        copyGeoJSON(button, legs, `Copied ${routes} routes / ${legs.length} legs`);
      }),
      makeButton("Copy station pairs (max speed)", (button) => {
        const legs = currentFeatures();
        const pairs = consolidateByStationPair(legs);
        copyGeoJSON(button, pairs, `Copied ${pairs.length} pairs / ${legs.length} legs`);
      }),
      makeButton("Show map pane", openMap),
    );
    document.body.append(panel);
  }

  rememberCards(document.documentElement);

  let scheduled = false;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") rememberCards(record.target);
      else record.addedNodes.forEach(rememberCards);
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      addButton();
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-rank"],
  });
  addButton();
})();
