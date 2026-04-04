const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AEMET_API_KEY = process.env.AEMET_API_KEY;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/municipios', async (req, res) => {
  try {
    const url = `https://opendata.aemet.es/opendata/api/maestro/municipios?api_key=${AEMET_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo municipios' });
  }
});

app.get('/api/prediccion/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const url = `https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/horaria/${id}?api_key=${AEMET_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    const datosUrl = data.datos;
    const datosResponse = await fetch(datosUrl);
    const datos = await datosResponse.json();

    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo predicción' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
