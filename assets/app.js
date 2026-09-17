const DATA_DIR = "data";

const CONFIDENCE_COLOR = {
  High: "#ff5630",
  Medium: "#ffab00",
  Low: "#ffd666",
};

// Define base map layers
const baseMaps = {
  "OSM": L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      subdomains: "abc",
      maxZoom: 19,
    }
  ),
  "Satelit": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution:
        'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19,
    }
  ),
};

const state = {
  index: null,
  cache: new Map(),
  layers: new Map(),
  aktif: new Set(),
  tanggalMulai: null,
  tanggalSelesai: null,
  adminBoundary: null,
  boundaryLayers: new Map(),
  boundaryLabels: new Map(),
  boundaryFeatures: new Map(),
  loading: new Set(),
  dailyStats: null,    // dari data/daily_stats.json
  showHotspot: true,   // toggle layer hotspot
  showBoundary: true,  // toggle layer batas daerah
  showLabel: true,     // toggle layer label daerah
};

const map = L.map("peta", {
  zoomControl: false,
}).setView([-0.05, 110.5], 7); // titik tengah kasar Kalimantan Barat

L.control.zoom({ position: "topright" }).addTo(map);

// Initialize base map (Satelit) as default
baseMaps["Satelit"].addTo(map);

async function init() {
  // Set up layer toggle controls
  document.getElementById("toggle-hotspot").addEventListener("change", function(e) {
    state.showHotspot = e.target.checked;
    toggleHotspotLayers();
  });

  document.getElementById("toggle-boundary").addEventListener("change", function(e) {
    state.showBoundary = e.target.checked;
    toggleBoundaryLayers();
  });

  document.getElementById("toggle-label").addEventListener("change", function(e) {
    state.showLabel = e.target.checked;
    toggleLabelLayers();
  });

  // Load index.json
  const res = await fetch(`${DATA_DIR}/index.json`);
  state.index = await res.json();

  // Load administrative boundaries
  try {
    const batasRes = await fetch(`${DATA_DIR}/batas-administrasi-kalbar.geojson`);
    state.adminBoundary = await batasRes.json();
    // Parse boundary features once, store by kab_kota
    state.boundaryFeatures = new Map();
    if (state.adminBoundary.features) {
      state.adminBoundary.features.forEach(feature => {
        const kabKota = feature.properties?.kab_kota;
        if (kabKota) state.boundaryFeatures.set(kabKota, feature);
      });
    }
  } catch (error) {
    console.error("Gagal memuat batas administratif:", error);
    state.adminBoundary = { features: [] };
  }

  // Load daily stats for dynamic counts on inactive regions
  try {
    const statsRes = await fetch(`${DATA_DIR}/daily_stats.json`);
    state.dailyStats = await statsRes.json();
  } catch (error) {
    console.warn("Gagal memuat daily stats:", error);
    state.dailyStats = {};
  }

  // Set up UI
  document.getElementById("periode-label").textContent =
    `${formatTglIndo(state.index.periode.mulai)} — ${formatTglIndo(state.index.periode.selesai)}`;

  const tglMulai = document.getElementById("tanggal-mulai");
  const tglSelesai = document.getElementById("tanggal-selesai");
  tglMulai.min = tglSelesai.min = state.index.periode.mulai;
  tglMulai.max = tglSelesai.max = state.index.periode.selesai;
  tglMulai.value = "2026-08-01";
  tglSelesai.value = "2026-08-01";
  state.tanggalMulai = "2026-08-01";
  state.tanggalSelesai = "2026-08-01";

  tglMulai.addEventListener("change", onTanggalUbah);
  tglSelesai.addEventListener("change", onTanggalUbah);

  renderDaftarWilayah();

  // Activate ALL regions by default
  for (const wilayah of state.index.kab_kota_list) {
    const kabKota = wilayah.nama;
    state.aktif.add(kabKota);
    await pastikanDataDimuat(kabKota);
    // Add to map if toggles permit
    const layer = state.layers.get(kabKota);
    if (layer && state.showHotspot) layer.addTo(map);
    
    const boundaryLayer = state.boundaryLayers.get(kabKota);
    if (boundaryLayer && state.showBoundary) {
      boundaryLayer.addTo(map);
      boundaryLayer.bringToBack();
    }
    
    if (!state.boundaryLabels.has(kabKota) && state.showLabel) {
      addRegionLabel(kabKota);
    }
  }
  updateJumlahSemuaItem();
  updateStatTotal();
  syncCheckboxes();
  updateAlertCard();

  // Basemap switcher
  document.querySelectorAll('input[name="basemap"]').forEach(r => {
    r.addEventListener('change', e => {
      const selected = e.target.value;
      Object.entries(baseMaps).forEach(([key, layer]) => {
        if (map.hasLayer(layer)) map.removeLayer(layer);
      });
      baseMaps[selected].addTo(map);

      // Re-add active layers
      for (const kabKota of state.aktif) {
        const layer = state.layers.get(kabKota);
        if (layer) layer.addTo(map);

        const boundaryLayer = state.boundaryLayers.get(kabKota);
        if (boundaryLayer) boundaryLayer.addTo(map);
      }
    });
  });
}

function toggleHotspotLayers() {
  state.layers.forEach((layer, kabKota) => {
    if (state.showHotspot && state.aktif.has(kabKota)) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
  });
  // Update statistics when hotspot layer is toggled
  updateStatTotal();
  // Also update alert card
  updateAlertCard();
}

function toggleBoundaryLayers() {
  state.boundaryLayers.forEach((layer, kabKota) => {
    if (state.showBoundary && state.aktif.has(kabKota)) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map);
        layer.bringToBack();
      }
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
  });
}

function toggleLabelLayers() {
  state.boundaryLabels.forEach((label, kabKota) => {
    if (state.showLabel && state.aktif.has(kabKota)) {
      if (!map.hasLayer(label)) label.addTo(map);
    } else {
      if (map.hasLayer(label)) map.removeLayer(label);
    }
  });
}

function addRegionLabel(kabKota) {
  // Find the feature for this kabKota in adminBoundary
  const feature = state.adminBoundary.features.find(f => f.properties.kab_kota === kabKota);
  if (!feature) return;
  const centroid = getPolygonCentroid(feature);
  const label = L.marker(centroid, {
    icon: L.divIcon({
      className: "region-label-container",
      html: `<div class="region-fixed-label">${kabKota.replace(/^(Kabupaten|Kota) /, "")}</div>`,
      iconSize: [null, null],
      iconAnchor: [0, 0]
    }),
    interactive: false
  });
  // Add to map only if label layer is enabled
  if (state.showLabel) {
    label.addTo(map);
  }
  state.boundaryLabels.set(kabKota, label);
}

function onWilayahToggle(nama, isActive) {
  if (isActive) {
    state.aktif.add(nama);
    pastikanDataDimuat(nama).then(() => {
      // Ensure label is present (in case it was removed earlier)
      if (!state.boundaryLabels.has(nama)) {
        addRegionLabel(nama);
      }
      // Add layers to map only if respective layer is enabled
      const layer = state.layers.get(nama);
      if (layer && state.showHotspot && !map.hasLayer(layer)) {
        layer.addTo(map);
      }
      const boundaryLayer = state.boundaryLayers.get(nama);
      if (boundaryLayer && state.showBoundary && !map.hasLayer(boundaryLayer)) {
        boundaryLayer.addTo(map);
        boundaryLayer.bringToBack();
      }
      const label = state.boundaryLabels.get(nama);
      if (label && state.showLabel && !map.hasLayer(label)) {
        label.addTo(map);
      }
      updateJumlahSemuaItem();
      updateStatTotal();
      syncCheckboxes();
    });
  } else {
    state.aktif.delete(nama);
    const layer = state.layers.get(nama);
    if (layer) map.removeLayer(layer);
    const boundaryLayer = state.boundaryLayers.get(nama);
    if (boundaryLayer) map.removeLayer(boundaryLayer);
    // Also remove the label when region is deactivated
    const label = state.boundaryLabels.get(nama);
    if (label) map.removeLayer(label);
    state.boundaryLabels.delete(nama);
    updateJumlahSemuaItem();
    updateStatTotal();
    syncCheckboxes();
  }
}

function updateStatTotal() {
  let total = 0;
  // Only count hotspot markers when the hotspot layer is enabled
  if (state.showHotspot) {
    for (const kabKota of state.aktif) {
      const layer = state.layers.get(kabKota);
      if (layer) total += layer.getLayers().length;
    }
  }
  document.getElementById("stat-total").textContent = total.toLocaleString("id-ID");
  document.getElementById("stat-wilayah").textContent = `${state.aktif.size}/14`;
}

function updateJumlahSemuaItem() {
  const wilayahItems = document.querySelectorAll(".wilayah-item");
  wilayahItems.forEach((item) => {
    const kabKota = item.dataset.kab;
    const jumlahElement = item.querySelector(".jumlah");
    const jumlahTitik = hitungJumlahTitik(kabKota);
    jumlahElement.textContent = jumlahTitik.toLocaleString("id-ID");
  });
}

function hitungJumlahTitik(kabKota) {
  const geojson = state.cache.get(kabKota);
  if (geojson) {
    // Gunakan data dari cache jika tersedia (filter by tanggal)
    const fitur = geojson.features.filter((f) =>
      dalamRentangTanggal(f.properties.tanggal)
    );
    return fitur.length;
  } else if (state.dailyStats) {
    // Gunakan daily_stats.json untuk hitung akurat per rentang tanggal
    let total = 0;
    for (const [date, stats] of Object.entries(state.dailyStats)) {
      if (dalamRentangTanggal(date)) {
        total += stats[kabKota] || 0;
      }
    }
    return total;
  } else {
    // Fallback terakhir: total dari index.json
    const wilayah = state.index.kab_kota_list.find((w) => w.nama === kabKota);
    return wilayah ? wilayah.jumlah_titik : 0;
  }
}

function syncCheckboxes() {
  document.querySelectorAll(".wilayah-item").forEach((item) => {
    const nama = item.dataset.kab;
    const cb = item.querySelector("input[type=checkbox]");
    const isActive = state.aktif.has(nama);
    cb.checked = isActive;
    item.classList.toggle("selected", isActive);
  });
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function toTitleCase(text) {
  return text
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatTglIndo(iso) {
  const [y, m, d] = iso.split("-");
  const bulan = [
    "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
  ];
  return `${parseInt(d, 10)} ${bulan[parseInt(m, 10) - 1]} ${y}`;
}

function getPolygonCentroid(feature) {
  // Get all rings (exterior rings only) from MultiPolygon/Polygon
  const rings = [];
  if (feature.geometry.type === 'Polygon') {
    rings.push(feature.geometry.coordinates[0]);
  } else if (feature.geometry.type === 'MultiPolygon') {
    feature.geometry.coordinates.forEach(poly => rings.push(poly[0]));
  }
  
  if (rings.length === 0) {
    // Fallback to bounds center
    const geojsonLayer = L.geoJSON(feature);
    return geojsonLayer.getBounds().getCenter();
  }
  
  // Find the largest ring (main polygon)
  let largestRing = rings[0];
  let maxArea = 0;
  for (const ring of rings) {
    const area = Math.abs(ringArea(ring));
    if (area > maxArea) {
      maxArea = area;
      largestRing = ring;
    }
  }

  // Calculate centroid of the largest ring
  let x = 0, y = 0;
  let area = 0;
  for (let i = 0; i < largestRing.length - 1; i++) {
    const [x1, y1] = largestRing[i];
    const [x2, y2] = largestRing[i + 1];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    x += (x1 + x2) * cross;
    y += (y1 + y2) * cross;
  }
  area *= 0.5;
  x /= 6 * area;
  y /= 6 * area;

  return L.latLng(y, x);
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

function dalamRentangTanggal(tanggal) {
  return tanggal >= state.tanggalMulai && tanggal <= state.tanggalSelesai;
}

function renderDaftarWilayah() {
  const container = document.getElementById("daftar-wilayah");
  container.innerHTML = "";

  state.index.kab_kota_list.forEach((wilayah) => {
    const item = document.createElement("li");
    item.className = "wilayah-item";
    item.dataset.kab = wilayah.nama;

    item.innerHTML = `
      <div class="left">
        <input type="checkbox" id="cb-${slugify(wilayah.nama)}">
        <span class="nama">${toTitleCase(wilayah.nama)}</span>
      </div>
      <span class="jumlah">${wilayah.jumlah_titik.toLocaleString("id-ID")}</span>
    `;

    const cb = item.querySelector("input[type=checkbox]");
    cb.addEventListener("change", (e) => {
      onWilayahToggle(wilayah.nama, e.target.checked);
    });

    item.addEventListener("click", (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        onWilayahToggle(wilayah.nama, cb.checked);
      }
    });

    container.appendChild(item);
  });

  // Set up clear button
  document.getElementById("btn-clear").addEventListener("click", () => {
    state.aktif.clear();
    // Remove all layers (hotspot, boundary, label) according to toggles
    state.layers.forEach((layer) => {
      if (state.showHotspot) map.removeLayer(layer);
    });
    state.boundaryLayers.forEach((layer) => {
      if (state.showBoundary) map.removeLayer(layer);
    });
    state.boundaryLabels.forEach((label) => {
      if (state.showLabel) map.removeLayer(label);
    });
    state.boundaryLabels.clear();
    syncCheckboxes();
    updateStatTotal();
    updateJumlahSemuaItem();
  });
}

async function onTanggalUbah() {
  const tglMulai = document.getElementById("tanggal-mulai");
  const tglSelesai = document.getElementById("tanggal-selesai");

  if (tglMulai.value && tglSelesai.value) {
    state.tanggalMulai = tglMulai.value;
    state.tanggalSelesai = tglSelesai.value;

    // Refresh active layers only (lazy load) respecting layer visibility flags
    for (const kabKota of state.aktif) {
      const layer = state.layers.get(kabKota);
      if (layer) {
        map.removeLayer(layer);
        await pastikanDataDimuat(kabKota);
        if (state.showHotspot) layer.addTo(map);
      }
      const boundaryLayer = state.boundaryLayers.get(kabKota);
      if (boundaryLayer) {
        map.removeLayer(boundaryLayer);
        if (state.showBoundary) boundaryLayer.addTo(map);
        boundaryLayer.bringToBack();
      }
      const label = state.boundaryLabels.get(kabKota);
      if (label) {
        map.removeLayer(label);
        if (state.showLabel) label.addTo(map);
      }
    }

    // Update counts for active regions (others show index.json total)
    updateJumlahSemuaItem();
    updateStatTotal();
    syncCheckboxes();
    // Update alert card after date change
    updateAlertCard();
  }
}

async function pastikanDataDimuat(kabKota) {
  if (state.loading.has(kabKota)) {
    // Already loading, wait for it
    while (state.loading.has(kabKota)) {
      await new Promise(r => setTimeout(r, 50));
    }
    return;
  }

  if (!state.cache.has(kabKota)) {
    state.loading.add(kabKota);
    setLoadingState(kabKota, true);
    try {
      const res = await fetch(`${DATA_DIR}/hotspot-${slugify(kabKota)}.geojson`);
      const geojson = await res.json();
      state.cache.set(kabKota, geojson);
    } finally {
      state.loading.delete(kabKota);
      setLoadingState(kabKota, false);
    }
  }

  // Create or update the layer
  if (!state.layers.has(kabKota)) {
    const layer = L.markerClusterGroup({
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      maxClusterRadius: 40,
      disableClusteringAtZoom: 16
    });
    state.layers.set(kabKota, layer);
  } else {
    state.layers.get(kabKota).clearLayers();
  }

  // Add markers to the layer
  const geojson = state.cache.get(kabKota);
  const fitur = geojson.features.filter((f) =>
    dalamRentangTanggal(f.properties.tanggal)
  );

  fitur.forEach((f) => {
    const marker = L.circleMarker(
      [f.geometry.coordinates[1], f.geometry.coordinates[0]],
      {
        radius: 6,
        fillColor: CONFIDENCE_COLOR[f.properties.confidence],
        color: "#ffffff",
        weight: 1,
        opacity: 1,
        fillOpacity: 0.8,
        className: "hotspot-marker"
      }
    );

    marker.bindPopup(`
      <dl class="popup-titik">
        <dt>Kabupaten/Kota</dt>
        <dd>${f.properties.kab_kota}</dd>
        <dt>Kecamatan</dt>
        <dd>${f.properties.kecamatan}</dd>
        <dt>Desa/Kelurahan</dt>
        <dd>${f.properties.desa}</dd>
        <dt>Tanggal</dt>
        <dd>${formatTglIndo(f.properties.tanggal)}</dd>
        <dt>Waktu (WIB)</dt>
        <dd>${new Date(f.properties.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</dd>
        <dt>Satelit</dt>
        <dd>${f.properties.satelit}</dd>
        <dt>Tingkat Keyakinan</dt>
        <dd>${f.properties.confidence}</dd>
        <dt>Koordinat</dt>
        <dd>${f.geometry.coordinates[1].toFixed(5)}, ${f.geometry.coordinates[0].toFixed(5)}</dd>
      </dl>
    `);

    state.layers.get(kabKota).addLayer(marker);
  });

  // Add to map only if this region is active and hotspot layer is enabled
  if (state.aktif.has(kabKota) && state.showHotspot) {
    state.layers.get(kabKota).addTo(map);
  }

  // Add administrative boundary layer using pre-parsed feature
  if (!state.boundaryLayers.has(kabKota)) {
    const feature = state.boundaryFeatures.get(kabKota);
    if (feature) {
      const boundaryLayer = L.geoJSON(feature, {
        style: {
          color: "#93c5fd",
          weight: 2,
          opacity: 0.8,
          fillOpacity: 0,
          interactive: false
        }
      });
      state.boundaryLayers.set(kabKota, boundaryLayer);
    }
  }

  // Add region label
  if (!state.boundaryLabels.has(kabKota)) {
    addRegionLabel(kabKota);
  }

  // Re-add boundary layer and label to map if region is active and respective layer is enabled
  if (state.aktif.has(kabKota)) {
    const boundaryLayer = state.boundaryLayers.get(kabKota);
    if (boundaryLayer && !map.hasLayer(boundaryLayer) && state.showBoundary) {
      boundaryLayer.addTo(map);
      boundaryLayer.bringToBack();
    }
    const label = state.boundaryLabels.get(kabKota);
    if (label && !map.hasLayer(label) && state.showLabel) {
      label.addTo(map);
    }
  }
}

function setLoadingState(kabKota, isLoading) {
  const item = document.querySelector(`.wilayah-item[data-kab="${kabKota}"]`);
  if (item) {
    const nama = item.querySelector('.nama');
    if (isLoading) {
      item.classList.add('loading');
      if (nama) nama.textContent = `${nama.textContent} ⏳`;
    } else {
      item.classList.remove('loading');
      // Restore original name
      const wilayah = state.index.kab_kota_list.find(w => w.nama === kabKota);
      if (wilayah && nama) {
        nama.textContent = toTitleCase(wilayah.nama);
      }
    }
  }
}

function updateAlertCard() {
  let maxCount = -1;
  let maxRegion = null;
  if (state.index && state.index.kab_kota_list) {
    for (const wilayah of state.index.kab_kota_list) {
      const kab = wilayah.nama;
      const count = hitungJumlahTitik(kab);
      if (count > maxCount) {
        maxCount = count;
        maxRegion = kab;
      }
    }
  }

  const alertContent = document.getElementById('alert-content');
  if (maxRegion !== null) {
    alertContent.innerHTML = `
      <span class="region-name">${toTitleCase(maxRegion)}</span>
      <span class="region-count">${maxCount.toLocaleString('id-ID')}</span>
    `;
  } else {
    alertContent.textContent = '-';
  }
}

init();