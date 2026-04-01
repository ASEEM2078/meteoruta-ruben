const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>MeteoRuta - Creado por Rubén</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
  <style>
    body { margin:0; font-family: Arial; }
    #map { height: 70vh; }
    .controls {
      padding:10px;
      background:#f4f4f4;
    }
    input {
      padding:5px;
      margin:5px;
      width:40%;
    }
    button {
      padding:6px 10px;
      background:#007bff;
      color:white;
      border:none;
      cursor:pointer;
    }
  </style>
</head>
<body>

<h2 style="text-align:center;">MeteoRuta AEMET</h2>
<p style="text-align:center;">Creado por Rubén</p>

<div class="controls">
  <input id="origen" placeholder="Origen (ej: Madrid)">
  <input id="destino" placeholder="Destino (ej: Valencia)">
  <button onclick="calcularRuta()">Calcular ruta</button>
</div>

<div id="map"></div>

<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>

<script>
  var map = L.map('map').setView([40.4168, -3.7038], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(map);

  var rutaLayer;

  async function geocode(ciudad) {
    let res = await fetch("https://nominatim.openstreetmap.org/search?format=json&q=" + ciudad);
    let data = await res.json();
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  }

  async function calcularRuta() {
    let origen = document.getElementById("origen").value;
    let destino = document.getElementById("destino").value;

    let coordsOrigen = await geocode(origen);
    let coordsDestino = await geocode(destino);

    if (rutaLayer) map.removeLayer(rutaLayer);

    let url = \`https://router.project-osrm.org/route/v1/driving/\${coordsOrigen[1]},\${coordsOrigen[0]};\${coordsDestino[1]},\${coordsDestino[0]}?overview=full&geometries=geojson\`;

    let res = await fetch(url);
    let data = await res.json();

    let ruta = data.routes[0].geometry;

    rutaLayer = L.geoJSON(ruta).addTo(map);

    map.fitBounds(rutaLayer.getBounds());
  }
</script>

</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
