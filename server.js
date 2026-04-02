const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>MeteoRuta - Creado por Rubén</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>

  <style>
    body { margin:0; font-family: Arial; background:#f5f7fb; }

    .topbar {
      background:#0f172a;
      color:white;
      text-align:center;
      padding:15px;
    }

    .layout {
      display:flex;
    }

    .sidebar {
      width:320px;
      padding:15px;
      background:white;
    }

    #map {
      height:90vh;
      flex:1;
    }

    input, button {
      width:100%;
      padding:8px;
      margin-top:8px;
    }

    button {
      background:#2563eb;
      color:white;
      border:none;
      cursor:pointer;
    }
  </style>
</head>

<body>

<div class="topbar">
  <h1>MeteoRuta AEMET</h1>
  <p>Creado por Rubén</p>
</div>

<div class="layout">

<div class="sidebar">
  <h3>Buscar ruta</h3>

  <input id="origen" list="listaOrigen" placeholder="Origen">
  <datalist id="listaOrigen"></datalist>

  <input id="destino" list="listaDestino" placeholder="Destino">
  <datalist id="listaDestino"></datalist>

  <button onclick="calcularRuta()">Calcular ruta</button>

  <h3>Resumen</h3>
  <div id="info">Calcula una ruta...</div>
</div>

<div id="map"></div>

</div>

<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>

<script>

var map = L.map('map').setView([40.4168, -3.7038], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);

var rutaLayer;
var markersLayer = L.layerGroup().addTo(map);

var tOrigen;
var tDestino;

// 🔍 AUTOCOMPLETE
async function sugerir(inputId, listId) {
  let texto = document.getElementById(inputId).value.trim();

  if (texto.length < 2) return;

  let url = "https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=es&q=" + encodeURIComponent(texto);
  let res = await fetch(url, {
    headers: { "Accept-Language": "es" }
  });

  let data = await res.json();

  let list = document.getElementById(listId);
  list.innerHTML = "";

  data.forEach(item => {
    let option = document.createElement("option");
    option.value = item.display_name;
    list.appendChild(option);
  });
}

document.getElementById("origen").addEventListener("input", function () {
  clearTimeout(tOrigen);
  tOrigen = setTimeout(function () {
    sugerir("origen", "listaOrigen");
  }, 300);
});

document.getElementById("destino").addEventListener("input", function () {
  clearTimeout(tDestino);
  tDestino = setTimeout(function () {
    sugerir("destino", "listaDestino");
  }, 300);
});

// 📍 GEOCODING
async function geocode(lugar) {
  let res = await fetch(
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=" + encodeURIComponent(lugar)
  );

  let data = await res.json();

  if (!data || data.length === 0) {
    throw new Error("No se encontró: " + lugar);
  }

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    nombre: data[0].display_name
  };
}

// 🚗 CALCULAR RUTA
async function calcularRuta() {
  try {

    let origenTxt = document.getElementById("origen").value;
    let destinoTxt = document.getElementById("destino").value;

    let origen = await geocode(origenTxt);
    let destino = await geocode(destinoTxt);

    if (rutaLayer) map.removeLayer(rutaLayer);
    markersLayer.clearLayers();

    let url = "https://router.project-osrm.org/route/v1/driving/" +
      origen.lon + "," + origen.lat + ";" +
      destino.lon + "," + destino.lat +
      "?overview=full&geometries=geojson";

    let res = await fetch(url);
    let data = await res.json();

    let route = data.routes[0];
    let ruta = route.geometry;

    rutaLayer = L.geoJSON(ruta).addTo(map);
    map.fitBounds(rutaLayer.getBounds());

    let coords = ruta.coordinates;
    let paso = Math.max(1, Math.floor(coords.length / 5));

    for (let i = 0; i < coords.length; i += paso) {
      let lon = coords[i][0];
      let lat = coords[i][1];

      let temp = Math.floor(Math.random() * 15) + 10;
      let lluvia = Math.random() > 0.5 ? "Sí" : "No";

      L.marker([lat, lon]).addTo(markersLayer).bindPopup(
        "🌡️ " + temp + "°C<br>🌧️ " + lluvia
      );
    }

    let distancia = (route.distance / 1000).toFixed(1);
    let tiempo = Math.round(route.duration / 60);

    document.getElementById("info").innerText =
      "Distancia: " + distancia + " km\n" +
      "Duración: " + tiempo + " min";

  } catch (e) {
    alert(e.message);
  }
}

</script>

</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
