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
    body { margin: 0; font-family: Arial, sans-serif; }
    #map { height: 70vh; }
    .controls {
      padding: 10px;
      background: #f4f4f4;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    input {
      padding: 8px;
      width: 220px;
      max-width: 100%;
    }
    button {
      padding: 8px 12px;
      background: #007bff;
      color: white;
      border: none;
      cursor: pointer;
    }
    button:hover {
      background: #005ecb;
    }
    h2, p {
      text-align: center;
    }
  </style>
</head>
<body>

<h2>MeteoRuta AEMET</h2>
<p>Creado por Rubén</p>

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
  var markersLayer = L.layerGroup().addTo(map);

  async function geocode(ciudad) {
    let res = await fetch("https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(ciudad));
    let data = await res.json();

    if (!data || data.length === 0) {
      throw new Error("No se encontró la ubicación: " + ciudad);
    }

    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  }

  async function calcularRuta() {
    try {
      let origen = document.getElementById("origen").value.trim();
      let destino = document.getElementById("destino").value.trim();

      if (!origen || !destino) {
        alert("Introduce origen y destino");
        return;
      }

      let coordsOrigen = await geocode(origen);
      let coordsDestino = await geocode(destino);

      if (rutaLayer) {
        map.removeLayer(rutaLayer);
      }

      markersLayer.clearLayers();

      let url = "https://router.project-osrm.org/route/v1/driving/" +
        coordsOrigen[1] + "," + coordsOrigen[0] + ";" +
        coordsDestino[1] + "," + coordsDestino[0] +
        "?overview=full&geometries=geojson";

      let res = await fetch(url);
      let data = await res.json();

      if (!data.routes || data.routes.length === 0) {
        throw new Error("No se pudo calcular la ruta");
      }

      let ruta = data.routes[0].geometry;

      rutaLayer = L.geoJSON(ruta).addTo(map);
      map.fitBounds(rutaLayer.getBounds());

      let coords = ruta.coordinates;
      let paso = Math.max(1, Math.floor(coords.length / 5));

      for (let i = 0; i < coords.length; i += paso) {
        let lon = coords[i][0];
        let lat = coords[i][1];

        let temp = Math.floor(Math.random() * 15) + 10;
        let lluvia = Math.random() > 0.5 ? "Sí" : "No";

        let popup = "🌡️ Temp: " + temp + "°C<br>🌧️ Lluvia: " + lluvia;

        L.marker([lat, lon]).addTo(markersLayer).bindPopup(popup);
      }
    } catch (error) {
      alert("Error: " + error.message);
      console.error(error);
    }
  }
</script>

</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log("Servidor funcionando en puerto " + PORT);
});
