const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeteoRuta - Creado por Rubén</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: #f5f7fb; }
    .topbar {
      background: #0f172a;
      color: white;
      text-align: center;
      padding: 16px;
    }
    .topbar h1 { margin: 0; }
    .topbar p { margin: 6px 0 0; }

    .layout {
      display: flex;
      min-height: calc(100vh - 92px);
    }

    .sidebar {
      width: 320px;
      min-width: 320px;
      background: white;
      padding: 16px;
      border-right: 1px solid #ddd;
    }

    .sidebar h3 { margin-top: 0; }

    .field { margin-bottom: 12px; }

    input, button {
      width: 100%;
      padding: 10px;
      margin-top: 6px;
      font-size: 14px;
    }

    button {
      background: #2563eb;
      color: white;
      border: none;
      cursor: pointer;
      border-radius: 6px;
    }

    button:hover {
      background: #1d4ed8;
    }

    #map {
      flex: 1;
      height: calc(100vh - 92px);
      min-height: 500px;
    }

    #info {
      margin-top: 16px;
      white-space: pre-line;
      font-size: 14px;
      line-height: 1.5;
    }

    @media (max-width: 900px) {
      .layout {
        flex-direction: column;
      }
      .sidebar {
        width: 100%;
        min-width: 100%;
      }
      #map {
        width: 100%;
        height: 65vh;
      }
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

      <div class="field">
        <label>Origen</label>
        <input id="origen" list="listaOrigen" placeholder="Escribe ciudad o pueblo">
        <datalist id="listaOrigen"></datalist>
      </div>

      <div class="field">
        <label>Destino</label>
        <input id="destino" list="listaDestino" placeholder="Escribe ciudad o pueblo">
        <datalist id="listaDestino"></datalist>
      </div>

      <button onclick="calcularRuta()">Calcular ruta</button>

      <h3 style="margin-top:20px;">Resumen</h3>
      <div id="info">Calcula una ruta...</div>
    </div>

    <div id="map"></div>
  </div>

  <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([40.4168, -3.7038], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    let rutaLayer = null;
    let markersLayer = L.layerGroup().addTo(map);
    let tOrigen = null;
    let tDestino = null;

    async function sugerir(inputId, listId) {
      const texto = document.getElementById(inputId).value.trim();
      if (texto.length < 2) return;

      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=es&q=" + encodeURIComponent(texto);
      const res = await fetch(url, {
        headers: { "Accept-Language": "es" }
      });
      const data = await res.json();

      const list = document.getElementById(listId);
      list.innerHTML = "";

      data.forEach(item => {
        const option = document.createElement("option");
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

    async function geocode(lugar) {
      const res = await fetch(
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=" + encodeURIComponent(lugar),
        { headers: { "Accept-Language": "es" } }
      );

      const data = await res.json();

      if (!data || data.length === 0) {
        throw new Error("No se encontró: " + lugar);
      }

      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        nombre: data[0].display_name
      };
    }

    async function calcularRuta() {
      try {
        const origenTxt = document.getElementById("origen").value.trim();
        const destinoTxt = document.getElementById("destino").value.trim();

        if (!origenTxt || !destinoTxt) {
          alert("Introduce origen y destino");
          return;
        }

        const origen = await geocode(origenTxt);
        const destino = await geocode(destinoTxt);

        if (rutaLayer) {
          map.removeLayer(rutaLayer);
        }
        markersLayer.clearLayers();

        const url = "https://router.project-osrm.org/route/v1/driving/" +
          origen.lon + "," + origen.lat + ";" +
          destino.lon + "," + destino.lat +
          "?overview=full&geometries=geojson";

        const res = await fetch(url);
        const data = await res.json();

        if (!data.routes || data.routes.length === 0) {
          throw new Error("No se pudo calcular la ruta");
        }

        const route = data.routes[0];
        const ruta = route.geometry;

        rutaLayer = L.geoJSON(ruta, {
          style: {
            color: "#2563eb",
            weight: 5
          }
        }).addTo(map);

        map.fitBounds(rutaLayer.getBounds());

        const coords = ruta.coordinates;
        const paso = Math.max(1, Math.floor(coords.length / 5));

        for (let i = 0; i < coords.length; i += paso) {
          const lon = coords[i][0];
          const lat = coords[i][1];

          const temp = Math.floor(Math.random() * 15) + 10;
          const lluvia = Math.random() > 0.5 ? "Sí" : "No";

          L.marker([lat, lon]).addTo(markersLayer).bindPopup(
            "🌡️ " + temp + "°C<br>🌧️ " + lluvia
          );
        }

        const distancia = (route.distance / 1000).toFixed(1);
        const tiempo = Math.round(route.duration / 60);

        document.getElementById("info").innerText =
          "Distancia: " + distancia + " km\\n" +
          "Duración: " + tiempo + " min";
      } catch (e) {
        console.error(e);
        alert(e.message);
      }
    }

    setTimeout(function () {
      map.invalidateSize();
    }, 300);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log("Servidor funcionando");
});
