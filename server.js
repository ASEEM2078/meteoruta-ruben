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
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f5f7fb;
      color: #1f2937;
    }

    .topbar {
      padding: 16px;
      background: #0f172a;
      color: white;
      text-align: center;
    }

    .topbar h1 {
      margin: 0;
      font-size: 28px;
    }

    .topbar p {
      margin: 6px 0 0;
      opacity: 0.9;
    }

    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 0;
      min-height: calc(100vh - 88px);
    }

    .sidebar {
      background: white;
      border-right: 1px solid #e5e7eb;
      padding: 16px;
      overflow-y: auto;
    }

    .map-wrap {
      position: relative;
    }

    #map {
      height: calc(100vh - 88px);
      width: 100%;
    }

    .block {
      margin-bottom: 18px;
      padding: 14px;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      background: #ffffff;
    }

    .block h3 {
      margin: 0 0 12px 0;
      font-size: 18px;
    }

    .field {
      margin-bottom: 12px;
      position: relative;
    }

    .field label {
      display: block;
      margin-bottom: 6px;
      font-size: 14px;
      font-weight: bold;
    }

    .field input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      font-size: 14px;
    }

    .suggestions {
      position: absolute;
      top: 70px;
      left: 0;
      right: 0;
      background: white;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0,0,0,0.08);
      z-index: 2000;
      max-height: 220px;
      overflow-y: auto;
      display: none;
    }

    .suggestion-item {
      padding: 10px 12px;
      cursor: pointer;
      border-bottom: 1px solid #f1f5f9;
      font-size: 14px;
    }

    .suggestion-item:hover {
      background: #eff6ff;
    }

    .btn {
      width: 100%;
      padding: 12px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: bold;
      cursor: pointer;
    }

    .btn:hover {
      background: #1d4ed8;
    }

    .summary {
      font-size: 14px;
      line-height: 1.5;
    }

    .metric {
      margin-bottom: 8px;
    }

    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: bold;
      margin-right: 6px;
    }

    .green { background: #dcfce7; color: #166534; }
    .yellow { background: #fef9c3; color: #854d0e; }
    .orange { background: #fed7aa; color: #9a3412; }
    .red { background: #fecaca; color: #991b1b; }

    .route-text {
      white-space: pre-line;
      background: #f8fafc;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid #e2e8f0;
      min-height: 140px;
    }

    .loading {
      color: #2563eb;
      font-weight: bold;
    }

    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: none;
        border-bottom: 1px solid #e5e7eb;
      }

      #map {
        height: 60vh;
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
    <aside class="sidebar">
      <div class="block">
        <h3>Buscar ruta</h3>

        <div class="field">
          <label for="origen">Origen</label>
          <input id="origen" autocomplete="off" placeholder="Escribe ciudad o pueblo">
          <div id="sugerenciasOrigen" class="suggestions"></div>
        </div>

        <div class="field">
          <label for="destino">Destino</label>
          <input id="destino" autocomplete="off" placeholder="Escribe ciudad o pueblo">
          <div id="sugerenciasDestino" class="suggestions"></div>
        </div>

        <button class="btn" onclick="calcularRuta()">Calcular ruta</button>
      </div>

      <div class="block">
        <h3>Resumen de la ruta</h3>
        <div id="resumenRuta" class="summary">Todavía no has calculado ninguna ruta.</div>
      </div>

      <div class="block">
        <h3>Previsión meteorológica escrita</h3>
        <div id="textoMeteo" class="route-text">
Calcula una ruta para ver el resumen meteorológico del trayecto.
        </div>
      </div>

      <div class="block">
        <h3>Nivel de aviso estimado</h3>
        <div id="nivelAviso">
          <span class="badge green">Sin calcular</span>
        </div>
      </div>
    </aside>

    <div class="map-wrap">
      <div id="map"></div>
    </div>
  </div>

  <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([40.4168, -3.7038], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    let rutaLayer = null;
    let markersLayer = L.layerGroup().addTo(map);
    let debounceTimers = {};

    function limpiarSugerencias(id) {
      const box = document.getElementById(id);
      box.innerHTML = "";
      box.style.display = "none";
    }

    async function buscarSugerencias(texto, suggestionsId, inputId) {
      if (!texto || texto.trim().length < 2) {
        limpiarSugerencias(suggestionsId);
        return;
      }

      const url = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=es&q=" + encodeURIComponent(texto);
      const res = await fetch(url, {
        headers: {
          "Accept-Language": "es"
        }
      });
      const data = await res.json();

      const box = document.getElementById(suggestionsId);
      box.innerHTML = "";

      if (!data || data.length === 0) {
        box.style.display = "none";
        return;
      }

      data.forEach(item => {
        const div = document.createElement("div");
        div.className = "suggestion-item";
        div.textContent = item.display_name;
        div.onclick = () => {
          document.getElementById(inputId).value = item.display_name;
          limpiarSugerencias(suggestionsId);
        };
        box.appendChild(div);
      });

      box.style.display = "block";
    }

    function prepararAutocomplete(inputId, suggestionsId) {
      const input = document.getElementById(inputId);

      input.addEventListener("input", () => {
        clearTimeout(debounceTimers[inputId]);
        debounceTimers[inputId] = setTimeout(() => {
          buscarSugerencias(input.value, suggestionsId, inputId);
        }, 300);
      });

      input.addEventListener("blur", () => {
        setTimeout(() => limpiarSugerencias(suggestionsId), 200);
      });
    }

    prepararAutocomplete("origen", "sugerenciasOrigen");
    prepararAutocomplete("destino", "sugerenciasDestino");

    async function geocode(lugar) {
      const res = await fetch(
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=" +
        encodeURIComponent(lugar),
        { headers: { "Accept-Language": "es" } }
      );
      const data = await res.json();

      if (!data || data.length === 0) {
        throw new Error("No se encontró la ubicación: " + lugar);
      }

      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        nombre: data[0].display_name
      };
    }

    function calcularTiempoTexto(segundos) {
      const horas = Math.floor(segundos / 3600);
      const minutos = Math.round((segundos % 3600) / 60);

      if (horas <= 0) return minutos + " min";
      return horas + " h " + minutos + " min";
    }

    function generarMeteoSimulada(numPuntos) {
      const datos = [];
      const avisos = ["verde", "verde", "amarillo", "naranja", "verde", "amarillo"];

      for (let i = 0; i < numPuntos; i++) {
        const temp = Math.floor(Math.random() * 16) + 8;
        const lluvia = Math.random() > 0.55;
        const viento = Math.floor(Math.random() * 45) + 5;
        const aviso = avisos[Math.floor(Math.random() * avisos.length)];

        datos.push({
          temp,
          lluvia,
          viento,
          aviso
        });
      }

      return datos;
    }

    function colorPorAviso(nivel) {
      if (nivel === "rojo") return "#dc2626";
      if (nivel === "naranja") return "#f97316";
      if (nivel === "amarillo") return "#eab308";
      return "#2563eb";
    }

    function badgeAviso(nivel) {
      if (nivel === "rojo") return '<span class="badge red">Aviso rojo</span>';
      if (nivel === "naranja") return '<span class="badge orange">Aviso naranja</span>';
      if (nivel === "amarillo") return '<span class="badge yellow">Aviso amarillo</span>';
      return '<span class="badge green">Sin avisos relevantes</span>';
    }

    function peorAviso(lista) {
      if (lista.includes("rojo")) return "rojo";
      if (lista.includes("naranja")) return "naranja";
      if (lista.includes("amarillo")) return "amarillo";
      return "verde";
    }

    async function calcularRuta() {
      try {
        const origenTexto = document.getElementById("origen").value.trim();
        const destinoTexto = document.getElementById("destino").value.trim();

        if (!origenTexto || !destinoTexto) {
          alert("Introduce origen y destino");
          return;
        }

        document.getElementById("resumenRuta").innerHTML = '<div class="loading">Calculando ruta...</div>';
        document.getElementById("textoMeteo").textContent = "Calculando previsión meteorológica...";

        const origen = await geocode(origenTexto);
        const destino = await geocode(destinoTexto);

        const url = "https://router.project-osrm.org/route/v1/driving/" +
          origen.lon + "," + origen.lat + ";" +
          destino.lon + "," + destino.lat +
          "?overview=full&geometries=geojson";

        const res = await fetch(url);
        const data = await res.json();

        if (!data.routes || data.routes.length === 0) {
          throw new Error("No se pudo calcular la ruta");
        }

        if (rutaLayer) {
          map.removeLayer(rutaLayer);
        }
        markersLayer.clearLayers();

        const route = data.routes[0];
        const ruta = route.geometry;

        const coords = ruta.coordinates;
        const paso = Math.max(1, Math.floor(coords.length / 5));
        const puntos = [];
        for (let i = 0; i < coords.length; i += paso) {
          puntos.push(coords[i]);
        }

        const meteo = generarMeteoSimulada(puntos.length);
        const avisoGlobal = peorAviso(meteo.map(m => m.aviso));

        rutaLayer = L.geoJSON(ruta, {
          style: {
            color: colorPorAviso(avisoGlobal),
            weight: 6,
            opacity: 0.85
          }
        }).addTo(map);

        map.fitBounds(rutaLayer.getBounds());

        puntos.forEach((punto, idx) => {
          const lon = punto[0];
          const lat = punto[1];
          const dato = meteo[idx];

          const popup =
            "<strong>Punto de ruta " + (idx + 1) + "</strong><br>" +
            "🌡️ Temperatura: " + dato.temp + "°C<br>" +
            "🌧️ Lluvia: " + (dato.lluvia ? "Sí" : "No") + "<br>" +
            "💨 Viento: " + dato.viento + " km/h<br>" +
            "⚠️ Aviso: " + dato.aviso;

          L.marker([lat, lon]).addTo(markersLayer).bindPopup(popup);
        });

        const distanciaKm = (route.distance / 1000).toFixed(1);
        const duracionTexto = calcularTiempoTexto(route.duration);

        document.getElementById("resumenRuta").innerHTML =
          "<div class='metric'><strong>Origen:</strong> " + origen.nombre + "</div>" +
          "<div class='metric'><strong>Destino:</strong> " + destino.nombre + "</div>" +
          "<div class='metric'><strong>Distancia:</strong> " + distanciaKm + " km</div>" +
          "<div class='metric'><strong>Duración estimada:</strong> " + duracionTexto + "</div>";

        const tempMedia = Math.round(meteo.reduce((acc, m) => acc + m.temp, 0) / meteo.length);
        const lluviaCount = meteo.filter(m => m.lluvia).length;
        const vientoMax = Math.max(...meteo.map(m => m.viento));

        let texto = "";
        texto += "Resumen meteorológico del trayecto:\\n\\n";
        texto += "- Temperatura media estimada: " + tempMedia + "°C\\n";
        texto += "- Tramos con posibilidad de lluvia: " + lluviaCount + " de " + meteo.length + "\\n";
        texto += "- Viento máximo estimado: " + vientoMax + " km/h\\n";
        texto += "- Nivel de aviso predominante: " + avisoGlobal + "\\n\\n";

        if (avisoGlobal === "naranja") {
          texto += "Se detecta un riesgo meteorológico elevado en parte del trayecto. Conviene revisar la situación antes de salir.";
        } else if (avisoGlobal === "amarillo") {
          texto += "Hay tramos con posible incidencia meteorológica moderada. Se recomienda precaución durante el viaje.";
        } else {
          texto += "No se aprecian incidencias meteorológicas importantes en la ruta calculada.";
        }

        document.getElementById("textoMeteo").textContent = texto;
        document.getElementById("nivelAviso").innerHTML = badgeAviso(avisoGlobal);

      } catch (error) {
        console.error(error);
        alert("Error: " + error.message);
        document.getElementById("resumenRuta").textContent = "No se pudo calcular la ruta.";
        document.getElementById("textoMeteo").textContent = "No se pudo generar la previsión.";
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
