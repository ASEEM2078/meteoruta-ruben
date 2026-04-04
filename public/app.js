let map;
let startMarker = null;
let endMarker = null;
let routeLayer = null;

let startPoint = null;
let endPoint = null;

const startCoordsEl = document.getElementById('startCoords');
const endCoordsEl = document.getElementById('endCoords');
const routeInfoEl = document.getElementById('routeInfo');
const statusBoxEl = document.getElementById('statusBox');
const btnClear = document.getElementById('btnClear');
const btnMyLocation = document.getElementById('btnMyLocation');

function initMap() {
  map = L.map('map').setView([40.4168, -3.7038], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  map.on('click', handleMapClick);
}

function handleMapClick(e) {
  const { lat, lng } = e.latlng;

  if (!startPoint) {
    startPoint = { lat, lng };
    placeStartMarker(startPoint);
    updateStartInfo();
    setStatus('Origen seleccionado. Ahora pulsa en el mapa para marcar el destino.');
    return;
  }

  if (!endPoint) {
    endPoint = { lat, lng };
    placeEndMarker(endPoint);
    updateEndInfo();
    setStatus('Destino seleccionado. Calculando ruta...');
    calculateRoute();
    return;
  }

  clearRouteAndPoints();

  startPoint = { lat, lng };
  placeStartMarker(startPoint);
  updateStartInfo();
  setStatus('Has empezado una nueva ruta. Ahora marca el destino.');
}

function placeStartMarker(point) {
  if (startMarker) {
    map.removeLayer(startMarker);
  }

  startMarker = L.marker([point.lat, point.lng], {
    title: 'Origen'
  }).addTo(map);

  startMarker.bindPopup('Origen').openPopup();
}

function placeEndMarker(point) {
  if (endMarker) {
    map.removeLayer(endMarker);
  }

  endMarker = L.marker([point.lat, point.lng], {
    title: 'Destino'
  }).addTo(map);

  endMarker.bindPopup('Destino').openPopup();
}

function updateStartInfo() {
  if (!startPoint) {
    startCoordsEl.textContent = 'No seleccionado';
    return;
  }

  startCoordsEl.textContent = `${startPoint.lat.toFixed(5)}, ${startPoint.lng.toFixed(5)}`;
}

function updateEndInfo() {
  if (!endPoint) {
    endCoordsEl.textContent = 'No seleccionado';
    return;
  }

  endCoordsEl.textContent = `${endPoint.lat.toFixed(5)}, ${endPoint.lng.toFixed(5)}`;
}

function setStatus(message) {
  statusBoxEl.textContent = message;
}

async function calculateRoute() {
  if (!startPoint || !endPoint) return;

  try {
    routeInfoEl.className = 'route-info empty';
    routeInfoEl.textContent = 'Calculando ruta...';

    const url = `/api/route?startLon=${startPoint.lng}&startLat=${startPoint.lat}&endLon=${endPoint.lng}&endLat=${endPoint.lat}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || 'No se pudo calcular la ruta.');
    }

    drawRoute(data.geometry);
    showRouteInfo(data.distance, data.duration, data.legs);
    setStatus('Ruta calculada correctamente.');
  } catch (error) {
    console.error(error);
    routeInfoEl.className = 'route-info';
    routeInfoEl.innerHTML = `<strong>Error:</strong> ${error.message}`;
    setStatus('Ha ocurrido un error al calcular la ruta.');
  }
}

function drawRoute(geometry) {
  if (routeLayer) {
    map.removeLayer(routeLayer);
  }

  routeLayer = L.geoJSON(geometry, {
    style: {
      weight: 6,
      opacity: 0.85
    }
  }).addTo(map);

  const bounds = routeLayer.getBounds();

  if (startMarker) bounds.extend(startMarker.getLatLng());
  if (endMarker) bounds.extend(endMarker.getLatLng());

  map.fitBounds(bounds, { padding: [40, 40] });
}

function showRouteInfo(distanceMeters, durationSeconds, legs = []) {
  const km = (distanceMeters / 1000).toFixed(1);
  const minutes = Math.round(durationSeconds / 60);
  const hours = (durationSeconds / 3600).toFixed(1);

  let stepsCount = 0;
  for (const leg of legs) {
    if (leg.steps && Array.isArray(leg.steps)) {
      stepsCount += leg.steps.length;
    }
  }

  routeInfoEl.className = 'route-info';
  routeInfoEl.innerHTML = `
    <div class="route-summary">
      <div class="big">${km} km</div>
      <div class="small"><strong>Duración estimada:</strong> ${minutes} min (${hours} h)</div>
      <div class="small"><strong>Tramos detectados:</strong> ${stepsCount}</div>
      <div class="legend-note">La ruta se ha calculado por carretera y queda lista para añadir meteorología más adelante.</div>
    </div>
  `;
}

function clearRouteAndPoints() {
  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }

  if (endMarker) {
    map.removeLayer(endMarker);
    endMarker = null;
  }

  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }

  startPoint = null;
  endPoint = null;

  updateStartInfo();
  updateEndInfo();

  routeInfoEl.className = 'route-info empty';
  routeInfoEl.textContent = 'Selecciona origen y destino para calcular la ruta.';
  setStatus('Ruta limpiada. Esperando nueva selección.');
}

function setStartFromCurrentLocation() {
  if (!navigator.geolocation) {
    alert('Tu navegador no permite geolocalización.');
    return;
  }

  setStatus('Obteniendo tu ubicación...');

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      map.setView([lat, lng], 13);

      if (!startPoint) {
        startPoint = { lat, lng };
        placeStartMarker(startPoint);
        updateStartInfo();
        setStatus('Tu ubicación se ha marcado como origen. Ahora selecciona destino.');
        return;
      }

      if (startPoint && !endPoint) {
        endPoint = { lat, lng };
        placeEndMarker(endPoint);
        updateEndInfo();
        setStatus('Tu ubicación se ha marcado como destino. Calculando ruta...');
        calculateRoute();
        return;
      }

      clearRouteAndPoints();
      startPoint = { lat, lng };
      placeStartMarker(startPoint);
      updateStartInfo();
      setStatus('Tu ubicación se ha marcado como nuevo origen.');
    },
    () => {
      setStatus('No se pudo obtener tu ubicación.');
      alert('No se pudo obtener tu ubicación.');
    },
    {
      enableHighAccuracy: true,
      timeout: 10000
    }
  );
}

btnClear.addEventListener('click', clearRouteAndPoints);
btnMyLocation.addEventListener('click', setStartFromCurrentLocation);

initMap();
