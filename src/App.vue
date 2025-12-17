<script setup>
import { reactive, ref, onMounted, computed, onBeforeUnmount } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/* -----------------------------
   STATE
------------------------------ */
const crime_url = ref('')
const dialog_err = ref(false)

// reference data from REST server
const codeList = ref([])          // [{code, type}]
const neighborhoodList = ref([])  // [{id, name}]

// incidents currently loaded
const incidents = ref([])

// Filters
const selectedCodes = ref([])
const selectedNeighborhoods = ref([])
const startDate = ref('')
const endDate = ref('')
const maxIncidents = ref(1000)

// ✅ Location search input (ONLY what user types)
const locationQuery = ref('')

// ✅ Separate display for map center (reverse geocode)
const mapCenterLabel = ref('')

// New incident form
const showNewIncidentForm = ref(false)
const newIncident = ref({
  case_number: '',
  date: '',
  time: '',
  code: '',
  incident: '',
  police_grid: '',
  neighborhood_number: '',
  block: ''
})

// lookup maps for fast access
const neighborhoodNameById = computed(() => {
  const m = new Map()
  for (const n of neighborhoodList.value) m.set(Number(n.id), n.name)
  return m
})

const codeTypeByCode = computed(() => {
  const m = new Map()
  for (const c of codeList.value) m.set(Number(c.code), c.type)
  return m
})

// leaflet / map state
const map = reactive({
  leaflet: null,
  center: { lat: 44.955139, lng: -93.102222 },
  zoom: 12,
  bounds: {
    nw: { lat: 45.008206, lng: -93.217977 },
    se: { lat: 44.883658, lng: -92.993787 }
  },
  neighborhood_markers: [],
  crimeMarker: null,

  // fixed marker locations (17 neighborhoods)
  neighborhood_locations: [
    { location: [44.942068, -93.020521], marker: null, id: 1 },
    { location: [44.977413, -93.025156], marker: null, id: 2 },
    { location: [44.931244, -93.079578], marker: null, id: 3 },
    { location: [44.956192, -93.060189], marker: null, id: 4 },
    { location: [44.978883, -93.068163], marker: null, id: 5 },
    { location: [44.975766, -93.113887], marker: null, id: 6 },
    { location: [44.959639, -93.121271], marker: null, id: 7 },
    { location: [44.947700, -93.128505], marker: null, id: 8 },
    { location: [44.930276, -93.119911], marker: null, id: 9 },
    { location: [44.982752, -93.147910], marker: null, id: 10 },
    { location: [44.963631, -93.167548], marker: null, id: 11 },
    { location: [44.973971, -93.197965], marker: null, id: 12 },
    { location: [44.949043, -93.178261], marker: null, id: 13 },
    { location: [44.934848, -93.176736], marker: null, id: 14 },
    { location: [44.913106, -93.170779], marker: null, id: 15 },
    { location: [44.937705, -93.136997], marker: null, id: 16 },
    { location: [44.949203, -93.093739], marker: null, id: 17 }
  ]
})

/* -----------------------------
   MAP INIT
------------------------------ */
let reverseTimer = null

function debounceReverseGeocode() {
  if (reverseTimer) clearTimeout(reverseTimer)
  reverseTimer = setTimeout(() => {
    updateCenterLabelFromMap()
  }, 350)
}

onMounted(() => {
  map.leaflet = L.map('leafletmap', { minZoom: 11, maxZoom: 18 })
    .setView([map.center.lat, map.center.lng], map.zoom)

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map.leaflet)

  map.leaflet.setMaxBounds([
    [map.bounds.se.lat, map.bounds.nw.lng],
    [map.bounds.nw.lat, map.bounds.se.lng]
  ])

  // district boundaries overlay
  const district_boundary = new L.geoJson()
  district_boundary.addTo(map.leaflet)

  fetch('/data/StPaulDistrictCouncil.geojson')
    .then((r) => r.json())
    .then((geo) => {
      geo.features.forEach((f) => district_boundary.addData(f))
    })
    .catch((e) => console.error('GeoJSON load error:', e))

  // ✅ Update *label* when map moves (DO NOT touch the search input)
  map.leaflet.on('moveend', debounceReverseGeocode)

  // initial label
  debounceReverseGeocode()
})

onBeforeUnmount(() => {
  if (reverseTimer) clearTimeout(reverseTimer)
})

/* -----------------------------
   REST HELPERS
------------------------------ */
function baseUrl() {
  return crime_url.value.replace(/\/+$/, '')
}

async function fetchJson(path) {
  const url = `${baseUrl()}${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return await res.json()
}

/* -----------------------------
   CORE LOADING
------------------------------ */
async function initializeCrimes() {
  try {
    codeList.value = await fetchJson('/codes')
    neighborhoodList.value = await fetchJson('/neighborhoods')
    await loadIncidents()

    alert(
      `Connected ✅\n` +
      `codes: ${codeList.value.length}\n` +
      `neighborhoods: ${neighborhoodList.value.length}\n` +
      `incidents: ${incidents.value.length}`
    )
  } catch (err) {
    console.error(err)
    alert('Failed to load REST data. Check REST server + URL.')
  }
}

async function loadIncidents() {
  const params = new URLSearchParams()
  params.set('limit', maxIncidents.value.toString())

  if (selectedCodes.value.length > 0) {
    params.set('code', selectedCodes.value.join(','))
  }
  if (selectedNeighborhoods.value.length > 0) {
    params.set('neighborhood', selectedNeighborhoods.value.join(','))
  }
  if (startDate.value) params.set('start_date', startDate.value)
  if (endDate.value) params.set('end_date', endDate.value)

  incidents.value = await fetchJson(`/incidents?${params.toString()}`)
  updateNeighborhoodCircles()
}

function updateNeighborhoodCircles() {
  // count incidents per neighborhood_number
  const counts = new Map()
  for (const inc of incidents.value) {
    const n = Number(inc.neighborhood_number)
    if (!Number.isFinite(n)) continue
    counts.set(n, (counts.get(n) || 0) + 1)
  }

  // remove old circles
  for (const nm of map.neighborhood_locations) {
    if (nm.marker) {
      nm.marker.remove()
      nm.marker = null
    }
  }

  const maxCount = Math.max(1, ...counts.values())

  for (const nm of map.neighborhood_locations) {
    const id = nm.id
    const count = counts.get(id) || 0

    const r = 8 + 25 * Math.sqrt(count / maxCount)
    const name = neighborhoodNameById.value.get(id) || `Neighborhood ${id}`

    nm.marker = L.circleMarker(nm.location, {
      radius: r,
      weight: 2,
      color: '#3388ff',
      fillColor: '#3388ff',
      opacity: 1,
      fillOpacity: 0.4
    })
      .addTo(map.leaflet)
      .bindPopup(`<b>${name}</b><br/>Incidents (top ${maxIncidents.value}): <b>${count}</b>`)
  }
}

/* -----------------------------
   LOCATION & MAP
------------------------------ */
function clampToStPaul(lat, lng) {
  // bounds: lat in [se.lat, nw.lat], lng in [nw.lng, se.lng]
  const clampedLat = Math.max(map.bounds.se.lat, Math.min(map.bounds.nw.lat, lat))
  const clampedLng = Math.max(map.bounds.nw.lng, Math.min(map.bounds.se.lng, lng))
  return { lat: clampedLat, lng: clampedLng }
}

async function updateCenterLabelFromMap() {
  if (!map.leaflet) return
  const center = map.leaflet.getCenter()

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${center.lat}&lon=${center.lng}&format=json`,
      {
        headers: {
          'Accept': 'application/json'
        }
      }
    )
    const data = await res.json()
    mapCenterLabel.value =
      data?.display_name || `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`
  } catch {
    mapCenterLabel.value = `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`
  }
}

async function handleLocationGo() {
  const q = locationQuery.value.trim()
  if (!q) return

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
      { headers: { 'Accept': 'application/json' } }
    )
    const data = await res.json()

    if (Array.isArray(data) && data.length > 0) {
      let lat = parseFloat(data[0].lat)
      let lng = parseFloat(data[0].lon)

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        alert('Location found but coordinates were invalid.')
        return
      }

      const clamped = clampToStPaul(lat, lng)
      map.leaflet.setView([clamped.lat, clamped.lng], 15, { animate: true })
      // ✅ keep what the user typed; label updates separately
    } else {
      alert('Location not found')
    }
  } catch (err) {
    alert('Location search failed: ' + (err?.message || err))
  }
}

/* -----------------------------
   FILTERS
------------------------------ */
function toggleCodeFilter(code) {
  const idx = selectedCodes.value.indexOf(code)
  if (idx > -1) selectedCodes.value.splice(idx, 1)
  else selectedCodes.value.push(code)
}

function toggleNeighborhoodFilter(id) {
  const idx = selectedNeighborhoods.value.indexOf(id)
  if (idx > -1) selectedNeighborhoods.value.splice(idx, 1)
  else selectedNeighborhoods.value.push(id)
}

async function applyFilters() {
  if (!crime_url.value) return
  try {
    await loadIncidents()
  } catch (err) {
    console.error(err)
    alert('Failed to reload incidents.')
  }
}

/* -----------------------------
   NEW INCIDENT
------------------------------ */
async function submitNewIncident() {
  const allFilled = Object.values(newIncident.value).every(v => v !== '')
  if (!allFilled) {
    alert('All fields must be filled out')
    return
  }

  try {
    const res = await fetch(`${baseUrl()}/new-incident`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newIncident.value)
    })
    if (!res.ok) throw new Error('Failed to add incident')

    alert('Incident added successfully!')
    showNewIncidentForm.value = false

    newIncident.value = {
      case_number: '',
      date: '',
      time: '',
      code: '',
      incident: '',
      police_grid: '',
      neighborhood_number: '',
      block: ''
    }

    await loadIncidents()
  } catch (err) {
    alert('Error adding incident: ' + err.message)
  }
}

/* -----------------------------
   DELETE INCIDENT
------------------------------ */
async function deleteIncident(caseNumber) {
  if (!confirm('Are you sure you want to delete this incident?')) return

  try {
    const res = await fetch(`${baseUrl()}/remove-incident`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_number: caseNumber })
    })
    if (!res.ok) throw new Error('Failed to delete incident')

    alert('Incident deleted successfully')
    await loadIncidents()
  } catch (err) {
    alert('Error deleting incident: ' + err.message)
  }
}

/* -----------------------------
   SHOW INCIDENT ON MAP
------------------------------ */
async function showIncidentOnMap(incident) {
  if (map.crimeMarker) {
    map.crimeMarker.remove()
    map.crimeMarker = null
  }

  const address = incident.block.replace(/(\d+)X/g, '$10') + ', St. Paul, MN'

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
      { headers: { 'Accept': 'application/json' } }
    )
    const data = await res.json()

    if (Array.isArray(data) && data.length > 0) {
      const lat = parseFloat(data[0].lat)
      const lng = parseFloat(data[0].lon)

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        alert('Could not locate address on map (invalid coords)')
        return
      }

      const redIcon = L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34]
      })

      map.crimeMarker = L.marker([lat, lng], { icon: redIcon }).addTo(map.leaflet)

      const incidentType = codeTypeByCode.value.get(Number(incident.code)) || incident.incident

      map.crimeMarker
        .bindPopup(
          `<div style="min-width: 200px">
             <b>${incidentType}</b><br/>
             ${incident.date} ${incident.time}<br/>
             ${incident.block}
           </div>`
        )
        .openPopup()

      map.leaflet.setView([lat, lng], 16, { animate: true })
    } else {
      alert('Could not locate address on map')
    }
  } catch (err) {
    alert('Error locating address: ' + err.message)
  }
}

/* -----------------------------
   CRIME CATEGORIZATION
------------------------------ */
function getCrimeCategory(code) {
  const c = parseInt(code)
  if (c >= 100 && c <= 599) return 'violent'
  if ((c >= 600 && c <= 999) || (c >= 1400 && c <= 1499)) return 'property'
  return 'other'
}

function getCategoryColor(code) {
  const category = getCrimeCategory(code)
  if (category === 'violent') return '#ffcdd2'
  if (category === 'property') return '#ffe0b2'
  return '#c8e6c9'
}

/* -----------------------------
   UI HANDLERS
------------------------------ */
function closeDialog() {
  const dialog = document.getElementById('rest-dialog')
  const url_input = document.getElementById('dialog-url')

  if (crime_url.value !== '' && url_input.checkValidity()) {
    dialog_err.value = false
    dialog.close()
    initializeCrimes()
  } else {
    dialog_err.value = true
  }
}
</script>

<template>
  <!-- REST API dialog -->
  <dialog id="rest-dialog" open>
    <h1 class="dialog-header">St. Paul Crime REST API</h1>

    <label class="dialog-label">URL:</label>
    <input
      id="dialog-url"
      class="dialog-input"
      type="url"
      v-model="crime_url"
      placeholder="http://localhost:8000"
    />

    <p class="dialog-error" v-if="dialog_err">
      Error: must enter valid URL
    </p>

    <br />
    <button class="button" type="button" @click="closeDialog">OK</button>
  </dialog>

  <!-- Main Content -->
  <div class="main-container">
    <h1>St. Paul Crime Data Explorer</h1>

    <!-- Location Search -->
    <div class="location-search">
      <label><strong>Location:</strong></label>

      <input
        type="text"
        v-model="locationQuery"
        @keyup.enter="handleLocationGo"
        placeholder="Enter address or coordinates..."
        class="location-input"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        name="crime-location-search"
      />

      <button @click="handleLocationGo" class="btn-primary">Go</button>
    </div>

    <!-- ✅ Separate label so typing never gets overwritten -->
    <div class="center-label" v-if="mapCenterLabel">
      <strong>Map center:</strong> <span>{{ mapCenterLabel }}</span>
    </div>

    <!-- Filters Section -->
    <div class="filters-section">
      <h3>Filters</h3>

      <div class="filter-row">
        <div class="filter-group">
          <label><strong>Start Date:</strong></label>
          <input type="date" v-model="startDate" />
        </div>
        <div class="filter-group">
          <label><strong>End Date:</strong></label>
          <input type="date" v-model="endDate" />
        </div>
        <div class="filter-group">
          <label><strong>Max Incidents:</strong></label>
          <input type="number" v-model.number="maxIncidents" min="1" max="10000" />
        </div>
      </div>

      <div class="filter-row">
        <details class="filter-details">
          <summary>Crime Types ({{ selectedCodes.length }} selected)</summary>
          <div class="checkbox-list">
            <label v-for="c in codeList" :key="c.code" class="checkbox-label">
              <input
                type="checkbox"
                :checked="selectedCodes.includes(c.code)"
                @change="toggleCodeFilter(c.code)"
              />
              {{ c.code }} — {{ c.type }}
            </label>
          </div>
        </details>

        <details class="filter-details">
          <summary>Neighborhoods ({{ selectedNeighborhoods.length }} selected)</summary>
          <div class="checkbox-list">
            <label v-for="n in neighborhoodList" :key="n.id" class="checkbox-label">
              <input
                type="checkbox"
                :checked="selectedNeighborhoods.includes(n.id)"
                @change="toggleNeighborhoodFilter(n.id)"
              />
              {{ n.name }}
            </label>
          </div>
        </details>
      </div>

      <button @click="applyFilters" class="btn-success">Apply Filters</button>
    </div>

    <!-- Map -->
    <div id="leafletmap"></div>

    <!-- Legend -->
    <div class="legend">
      <strong>Crime Categories:</strong>
      <div class="legend-item">
        <span class="legend-box violent"></span>
        <span>Violent Crimes</span>
      </div>
      <div class="legend-item">
        <span class="legend-box property"></span>
        <span>Property Crimes</span>
      </div>
      <div class="legend-item">
        <span class="legend-box other"></span>
        <span>Other Crimes</span>
      </div>
    </div>

    <!-- New Incident Form Toggle -->
    <button @click="showNewIncidentForm = !showNewIncidentForm" class="btn-primary">
      {{ showNewIncidentForm ? '✕ Close Form' : '+ Add New Incident' }}
    </button>

    <!-- New Incident Form -->
    <div v-if="showNewIncidentForm" class="new-incident-form">
      <h3>New Incident Form</h3>
      <div class="form-grid">
        <div v-for="(value, field) in newIncident" :key="field" class="form-field">
          <label>{{ field.replace(/_/g, ' ') }}:</label>
          <input type="text" v-model="newIncident[field]" :placeholder="`Enter ${field.replace(/_/g, ' ')}`" />
        </div>
      </div>
      <button @click="submitNewIncident" class="btn-success">Submit Incident</button>
    </div>

    <!-- Incidents Table -->
    <div class="table-section">
      <h3>Crime Incidents ({{ incidents.length }} total)</h3>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Case #</th>
              <th>Date</th>
              <th>Time</th>
              <th>Incident</th>
              <th>Block</th>
              <th>Neighborhood</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="inc in incidents"
              :key="inc.case_number"
              :style="{ backgroundColor: getCategoryColor(inc.code) }"
            >
              <td>{{ inc.case_number }}</td>
              <td>{{ inc.date }}</td>
              <td>{{ inc.time }}</td>
              <td>{{ inc.incident }}</td>
              <td class="small-text">{{ inc.block }}</td>
              <td>{{ neighborhoodNameById.get(inc.neighborhood_number) || 'N' + inc.neighborhood_number }}</td>
              <td class="actions-cell">
                <button @click="showIncidentOnMap(inc)" class="btn-map">📍 Map</button>
                <button @click="deleteIncident(inc.case_number)" class="btn-delete">🗑️ Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 1rem;
  font-family: system-ui, -apple-system, sans-serif;
}

h1 {
  margin-top: 0;
  color: #1976d2;
}

/* Location Search */
.location-search {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  margin-bottom: 0.5rem;
}

.location-input {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1rem;
}

.center-label {
  margin-bottom: 1.25rem;
  font-size: 0.95rem;
  color: #333;
}

/* Filters */
.filters-section {
  background: #f9f9f9;
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.filters-section h3 {
  margin-top: 0;
}

.filter-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.filter-group input {
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}

.filter-details {
  flex: 1;
  background: white;
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 0.5rem;
}

.filter-details summary {
  cursor: pointer;
  font-weight: bold;
  padding: 0.5rem;
}

.checkbox-list {
  max-height: 300px;
  overflow-y: auto;
  padding: 0.5rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  cursor: pointer;
}

/* Map */
#leafletmap {
  height: 500px;
  margin-bottom: 1rem;
  border: 2px solid #ccc;
  border-radius: 8px;
}

/* Legend */
.legend {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 1rem;
  background: #f5f5f5;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.legend-box {
  width: 30px;
  height: 20px;
  border: 1px solid #999;
}

.legend-box.violent {
  background: #ffcdd2;
}

.legend-box.property {
  background: #ffe0b2;
}

.legend-box.other {
  background: #c8e6c9;
}

/* New Incident Form */
.new-incident-form {
  background: #e3f2fd;
  border: 2px solid #1976d2;
  border-radius: 8px;
  padding: 1rem;
  margin: 1rem 0;
}

.new-incident-form h3 {
  margin-top: 0;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.form-field label {
  font-weight: bold;
  text-transform: capitalize;
}

.form-field input {
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}

/* Table */
.table-section {
  margin-top: 1.5rem;
}

.table-container {
  max-height: 500px;
  overflow: auto;
  border: 1px solid #ccc;
  border-radius: 8px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

thead {
  position: sticky;
  top: 0;
  background: #1976d2;
  color: white;
  z-index: 10;
}

th {
  padding: 0.75rem;
  text-align: left;
  border-bottom: 2px solid #0d47a1;
}

td {
  padding: 0.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.small-text {
  font-size: 0.85rem;
}

.actions-cell {
  text-align: center;
}

/* Buttons */
.btn-primary {
  padding: 0.75rem 1.5rem;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  font-size: 1rem;
}

.btn-primary:hover {
  background: #1565c0;
}

.btn-success {
  padding: 0.75rem 1.5rem;
  background: #2e7d32;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  font-size: 1rem;
}

.btn-success:hover {
  background: #1b5e20;
}

.btn-map {
  padding: 0.4rem 0.8rem;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.85rem;
  margin-right: 0.5rem;
}

.btn-map:hover {
  background: #1565c0;
}

.btn-delete {
  padding: 0.4rem 0.8rem;
  background: #d32f2f;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.85rem;
}

.btn-delete:hover {
  background: #b71c1c;
}

/* Dialog */
#rest-dialog {
  width: 22rem;
  margin-top: 1rem;
  padding: 1.5rem;
  border: 2px solid #1976d2;
  border-radius: 8px;
  z-index: 1000;
}

.dialog-header {
  font-size: 1.2rem;
  font-weight: bold;
  margin-top: 0;
}

.dialog-label {
  font-size: 1rem;
  font-weight: bold;
}

.dialog-input {
  font-size: 1rem;
  width: 100%;
  padding: 0.5rem;
  margin: 0.5rem 0;
  border: 1px solid #ccc;
  border-radius: 4px;
}

.dialog-error {
  font-size: 1rem;
  color: #d32323;
}

.button {
  padding: 0.75rem 1.5rem;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}
</style>
