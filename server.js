const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint de prueba
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'MeteoRuta' });
});

// Endpoint para calcular ruta con OSRM
app.get('/api/route', async (req, res) => {
  const { startLon, startLat, endLon, endLat } = req.query;

  if (!startLon || !startLat || !endLon || !endLat) {
    return res.status(400).json({
      error: 'Faltan coordenadas. Debes enviar startLon, startLat, endLon y endLat.'
    });
  }

  const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=true`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(502).json({
        error: 'Error al consultar el servicio de rutas.'
      });
    }

    const data = await response.json();

    if (!data.routes || !data.routes.length) {
      return res.status(404).json({
        error: 'No se encontró ninguna ruta.'
      });
    }

    const route = data.routes[0];

    res.json({
      distance: route.distance,
      duration: route.duration,
      geometry: route.geometry,
      legs: route.legs
    });
  } catch (error) {
    console.error('Error calculando ruta:', error);
    res.status(500).json({
      error: 'Error interno al calcular la ruta.'
    });
  }
});

// Cargar index.html para cualquier ruta no API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MeteoRuta funcionando en http://localhost:${PORT}`);
});
