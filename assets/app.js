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
  index: null,          // isi data/index.json
  cache: new Map(),      // kab_kota -> geojson mentah (sudah di-fetch)
  layers: new Map(),     // kab_kota -> L.markerClusterGroup aktif di peta
  aktif: new Set(),      // kab_kota yang checkbox-nya sedang dicentang
  tanggalMulai: null,
  tanggalSelesai: null,
  adminBoundary: null,   // batas administratif
  boundaryLayers: new Map(), // kab_kota -> layer batas administratif
};

const map = L.map("peta", {
  zoomControl: false,
}).setView([-0.05, 110.5], 7); // titik tengah kasar Kalimantan Barat

L.control.zoom({ position: "topright" }).addTo(map);

// Initialize base map (Satelit) as default
baseMaps["Satelit"].addTo(map);

init();

async function init() {
  // Load index.json
  const res = await fetch(`${DATA_DIR}/index.json`);
  state.index = await res.json();

  // Load administrative boundaries
  try {
    const batasRes = await fetch(`${DATA_DIR}/batas-administrasi-kalbar.geojson`);
    state.adminBoundary = await batasRes.json();
    state.boundaryLayers = new Map();
  } catch (error) {
    console.error("Gagal memuat batas administratif:", error);
    state.adminBoundary = { features: [] }; // Fallback kosong
  }

  // Set up UI
  document.getElementById("periode-label").textContent =
    `${formatTglIndo(state.index.periode.mulai)} — ${formatTglIndo(state.index.periode.selesai)}`;

  const tglMulai = document.getElementById("tanggal-mulai");
  const tglSelesai = document.getElementById("tanggal-selesai");
  tglMulai.min = tglSelesai.min = state.index.periode.mulai;
  tglMulai.max = tglSelesai.max = state.index.periode.selesai;
  tglMulai.value = state.index.periode.mulai;
  tglSelesai.value = state.index.periode.selesai;
  state.tanggalMulai = state.index.periode.mulai;
  state.tanggalSelesai = state.index.periode.selesai;

  tglMulai.addEventListener("change", onTanggalUbah);
  tglSelesai.addEventListener("change", onTanggalUbah);

  renderDaftarWilayah();

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

  document.getElementById("btn-clear").addEventListener("click", () => {
    state.aktif.forEach((kab) => setWilayahAktif(kab, false));
    syncCheckboxes();
  });

  // Default: aktifkan Kota Pontianak dan Kota Singkawang
  const defaultAwal = ["KOTA PONTIANAK", "KOTA SINGKAWANG"];
  for (const nama of defaultAwal) {
    await setWilayahAktif(nama, true);
  }
  syncCheckboxes();
  updateJumlahSemuaItem();
}

function renderDaftarWilayah() {
  const ul = document.getElementById("daftar-wilayah");
  ul.innerHTML = "";

  const urutan = [...state.index.kab_kota_list].sort((a, b) =>
    a.nama.localeCompare(b.nama)
  );

  for (const wilayah of urutan) {
    const li = document.createElement("li");
    li.className = "wilayah-item";
    li.dataset.kab = wilayah.nama;

    li.innerHTML = `
      <span class="left">
        <input type="checkbox" id="cb-${slugify(wilayah.nama)}">
        <span class="nama">${toTitleCase(wilayah.nama)}</span>
      </span>
      <span class="jumlah">${wilayah.jumlah_titik.toLocaleString("id-ID")}</span>
    `;

    const checkbox = li.querySelector("input");
    checkbox.addEventListener("change", (e) => {
      setWilayahAktif(wilayah.nama, e.target.checked);
    });

    // Toggle checkbox when clicking anywhere on the item (except checkbox itself)
    li.addEventListener("click", (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }))
      }
    });

    ul.appendChild(li);
  }
}

async function setWilayahAktif(kabKota, aktif) {
  if (aktif) {
    state.aktif.add(kabKota);
    await pastikanDataDimuat(kabKota);
    gambarLayer(kabKota);
  } else {
    state.aktif.delete(kabKota);
    const layer = state.layers.get(kabKota);
    if (layer) {
      map.removeLayer(layer);
      state.layers.delete(kabKota);
    }
    // Remove boundary layer if exists
    const boundaryLayer = state.boundaryLayers.get(kabKota);
    if (boundaryLayer) {
      map.removeLayer(boundaryLayer);
      state.boundaryLayers.delete(kabKota);
    }
  }
  updateStatTotal();
  updateJumlahSemuaItem();
  syncCheckboxes();
}

async function pastikanDataDimuat(kabKota) {
  if (state.cache.has(kabKota)) return;
  const wilayah = state.index.kab_kota_list.find((w) => w.nama === kabKota);
  const res = await fetch(`${DATA_DIR}/${wilayah.file}`);
  const geojson = await res.json();
  state.cache.set(kabKota, geojson);
}

// Palet warna untuk batas administratif
const ADMIN_BOUNDARY_COLORS = {
  "BENGKAYANG": "#FF5733",    // Merah terang
  "MEMPAWAH": "#33FF57",      // Hijau terang
  "KAPUAS HULU": "#3357FF",  // Biru terang
  "KAYONG UTARA": "#F033FF",  // Ungu terang
  "KETAPANG": "#FF33F0",      // Pink terang
  "KOTA PONTIANAK": "#33FFF0", // Cyan terang
  "KOTA SINGKAWANG": "#FF8C33", // Oranye terang
  "KUBU RAYA": "#8C33FF",    // Ungu muda terang
  "LANDAK": "#33FF8C",       // Hijau muda terang
  "MELAWI": "#FF338C",       // Merah muda terang
  "SAMBAS": "#8CFF33",       // Hijau kuning terang
  "SANGGAU": "#338CFF",      // Biru muda terang
  "SEKADAU": "#FF3333",      // Merah cerah
  "SINTANG": "#33FF33"       // Hijau cerah
};

function gambarLayer(kabKota) {
  // Hapus layer lama jika ada
  const lamaLayer = state.layers.get(kabKota);
  if (lamaLayer) map.removeLayer(lamaLayer);

  // Hapus boundary layer lama jika ada
  const lamaBoundary = state.boundaryLayers.get(kabKota);
  if (lamaBoundary) map.removeLayer(lamaBoundary);

  const geojson = state.cache.get(kabKota);
  if (!geojson) return;

  // Buat cluster untuk titik panas
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    iconCreateFunction: (cluster) => {
      const markers = cluster.getAllChildMarkers();
      const counts = { High: 0, Medium: 0, Low: 0 };
      markers.forEach(m => {
        const conf = m.options.confidence || 'Medium';
        if (counts[conf] !== undefined) counts[conf]++;
      });
      let dominant = 'Medium';
      let maxCount = 0;
      for (const [conf, cnt] of Object.entries(counts)) {
        if (cnt > maxCount) { maxCount = cnt; dominant = conf; }
      }
      const total = markers.length;
      const color = CONFIDENCE_COLOR[dominant] || CONFIDENCE_COLOR.Medium;
      const size = Math.min(20 + total * 1.5, 40);
      return L.divIcon({
        html: `<div style="background:${color}80;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.2)">${total}</div>`,
        className: 'custom-marker-cluster',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
      });
    }
  });

  // Tambahkan boundary polygon
  const boundaryFeature = state.adminBoundary.features.find(
    f => f.properties.kab_kota === kabKota
  );

  if (boundaryFeature) {
    const boundaryColor = ADMIN_BOUNDARY_COLORS[kabKota] || '#ffea00';

    const boundaryLayer = L.geoJSON(boundaryFeature, {
      style: {
        color: boundaryColor,
        weight: 3,
        fillColor: boundaryColor,
        fillOpacity: 0.15
      }
    }).addTo(map);
    boundaryLayer.bringToFront();
    state.boundaryLayers.set(kabKota, boundaryLayer);
  }

  // Tambahkan titik panas
  const fitur = geojson.features.filter((f) =>
    dalamRentangTanggal(f.properties.tanggal)
  );

  for (const f of fitur) {
    const [lon, lat] = f.geometry.coordinates;
    const confidence = f.properties.confidence;
    const warna = CONFIDENCE_COLOR[confidence] || "#8b93a1";

    const marker = L.circleMarker([lat, lon], {
      radius: 5,
      color: warna,
      weight: 1,
      fillColor: warna,
      fillOpacity: 0.85,
    });
    marker.options.confidence = confidence;

    marker.bindPopup(buatIsiPopup(f.properties));
    cluster.addLayer(marker);
  }

  cluster.addTo(map);
  state.layers.set(kabKota, cluster);
}

function buatIsiPopup(p) {
  return `
    <dl class="popup-titik">
      <dt>Wilayah</dt><dd>${toTitleCase(p.kab_kota)} &middot; ${p.kecamatan}</dd>
      <dt>Desa</dt><dd>${p.desa}</dd>
      <dt>Tanggal</dt><dd>${formatTglIndo(p.tanggal)}</dd>
      <dt>Satelit</dt><dd>${p.satelit}</dd>
      <dt>Confidence</dt><dd>${p.confidence}</dd>
    </dl>
  `;
}

function dalamRentangTanggal(tanggalIso) {
  return tanggalIso >= state.tanggalMulai && tanggalIso <= state.tanggalSelesai;
}

function onTanggalUbah() {
  const mulai = document.getElementById("tanggal-mulai").value;
  const selesai = document.getElementById("tanggal-selesai").value;
  state.tanggalMulai = mulai;
  state.tanggalSelesai = selesai;

  // Gambar ulang semua layer yang sedang aktif dengan rentang tanggal baru
  for (const kabKota of state.aktif) {
    gambarLayer(kabKota);
  }

  // Load data untuk semua wilayah yang belum di-cache agar hitungan akurat
  const belumCache = state.index.kab_kota_list
    .filter(w => !state.cache.has(w.nama))
    .map(w => w.nama);

  for (const nama of belumCache) {
    pastikanDataDimuat(nama).then(() => {
      updateJumlahSemuaItem();
    });
  }

  updateStatTotal();
  updateJumlahSemuaItem();
}

function updateStatTotal() {
  let total = 0;
  for (const kabKota of state.aktif) {
    const layer = state.layers.get(kabKota);
    if (layer) total += layer.getLayers().length;
  }
  document.getElementById("stat-total").textContent = total.toLocaleString("id-ID");
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
  if (!geojson) {
    // Fallback: gunakan jumlah dari index.json jika data belum di-load
    const wilayah = state.index.kab_kota_list.find((w) => w.nama === kabKota);
    return wilayah ? wilayah.jumlah_titik : 0;
  }

  const fitur = geojson.features.filter((f) =>
    dalamRentangTanggal(f.properties.tanggal)
  );

  return fitur.length;
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