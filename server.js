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
        h1 { text-align:center; }
        #map { height: 80vh; }
      </style>
    </head>
    <body>
      <h1>MeteoRuta AEMET</h1>
      <p style="text-align:center;">Creado por Rubén</p>
      <div id="map"></div>

      <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
      <script>
        var map = L.map('map').setView([40.4168, -3.7038], 6);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap'
        }).addTo(map);

        L.marker([40.4168, -3.7038]).addTo(map)
          .bindPopup('Madrid')
          .openPopup();
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
