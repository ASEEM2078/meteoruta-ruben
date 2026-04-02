const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AEMET_API_KEY = process.env.AEMET_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));

let municipiosCache = null;
let municipiosCacheTime = 0;

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function aemetStep(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      api_key: AEMET_API_KEY
    }
  });

  if (!res.ok) {
    throw new Error('Error AEMET paso 1: ' + res.status);
  }

  const meta = await res.json();

  if (!meta.datos) {
    throw new Error('AEMET no devolvió URL de datos');
  }

  const dataRes = await fetch(meta.datos);
  if (!dataRes.ok) {
    throw new Error('Error AEMET paso 2: ' + dataRes.status);
  }

  return await dataRes.json();
}

async function getMunicipios() {
  const now = Date.now();

  if (municipiosCache && now - municipiosCacheTime < 12 * 60 * 60 * 1000) {
    return municipiosCache;
  }

  const url = 'https://opendata.aemet.es/opendata/api/maestro/municipios';
  const data = await aemetStep(url);

  municipiosCache = data.map(item => ({
    id: String(item.id || '').replace(/^id/, ''),
    nombre: item.nombre || '',
    nombreNorm: normalizeText(item.nombre || ''),
    provincia: item.provincia || ''
  }));

  municipiosCacheTime = now;
  return municipiosCache;
}

function escogerMunicipio(texto, municipios) {
  const raw = (texto || '').split(',')[0].trim();
  const norm = normalizeText(raw);

  let exact = municipios.find(m => m.nombreNorm === norm);
  if (exact) return exact;

  let contains = municipios.find(m => m.nombreNorm.includes(norm) || norm.includes(m.nombreNorm));
  if (contains) return contains;

  return null;
}

function extraerResumenPrediccion(pred) {
  const hoy = pred?.prediccion?.dia?.[0];

  if (!hoy) {
    return {
      texto: 'Sin predicción disponible',
      avisoColor: 'verde'
    };
  }

  const estado = hoy.estadoCielo?.find(Boolean)?.descripcion || 'Sin dato';
  const tempMax = hoy.temperatura?.maxima ?? '—';
  const tempMin = hoy.temperatura?.minima ?? '—';
  const viento = hoy.viento?.find(Boolean)?.velocidad ?? '—';
  const probLluvia = hoy.probPrecipitacion?.find(Boolean)?.value ?? '—';

  let avisoColor = 'verde';
  const lluviaNum = Number(probLluvia);

  if (!Number.isNaN(lluviaNum) && lluviaNum >= 70) avisoColor = 'naranja';
  else if (!Number.isNaN(lluviaNum) && lluviaNum >= 40) avisoColor = 'amarillo';

  const texto =
    'Estado del cielo: ' + estado + '\n' +
    'Temperatura mínima: ' + tempMin + '°C\n' +
    'Temperatura máxima: ' + tempMax + '°C\n' +
    'Probabilidad de precipitación: ' + probLluvia + '%\n' +
    'Viento: ' + viento + ' km/h';

  return { texto, avisoColor, tempMin, tempMax, probLluvia, estado };
}

app.get('/api/municipio-prediccion', async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: 'Falta AEMET_API_KEY en Render' });
    }

    const lugar = req.query.lugar;
    if (!lugar) {
      return res.status(400).json({ error: 'Falta parámetro lugar' });
    }

    const municipios = await getMunicipios();
    const municipio = escogerMunicipio(lugar, municipios);

    if (!municipio) {
      return res.status(404).json({ error: 'No se encontró municipio AEMET para ' + lugar });
    }

    const data = await aemetStep(
      'https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/' + municipio.id
    );

    const pred = Array.isArray(data) ? data[0] : data;
    const resumen = extraerResumenPrediccion(pred);

    res.json({
      municipio: municipio.nombre,
      provincia: municipio.provincia,
      resumen
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ruta-meteo', async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: 'Falta AEMET_API_KEY en Render' });
    }

    const puntos = JSON.parse(req.query.puntos || '[]');

    if (!Array.isArray(puntos) || puntos.length === 0) {
      return res.status(400).json({ error: 'Faltan puntos de ruta' });
    }

    const municipios = await getMunicipios();
    const resultados = [];

    for (const p of puntos) {
      const nombreBase = (p.nombre || '').split(',')[0];
      const municipio = escogerMunicipio(nombreBase, municipios);

      if (!municipio) {
        resultados.push({
          nombre: p.nombre || 'Punto',
          error: 'Sin municipio AEMET asociado',
          avisoColor: 'verde',
          lat: p.lat,
          lon: p.lon
        });
        continue;
      }

      try {
        const data = await aemetStep(
          'https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/' + municipio.id
        );

        const pred = Array.isArray(data) ? data[0] : data;
        const resumen = extraerResumenPrediccion(pred);

        resultados.push({
          nombre: municipio.nombre,
          provincia: municipio.provincia,
          lat: p.lat,
          lon: p.lon,
          ...resumen
        });
      } catch (e) {
        resultados.push({
          nombre: municipio.nombre,
          provincia: municipio.provincia,
          lat: p.lat,
          lon: p.lon,
          error: e.message,
          avisoColor: 'verde'
        });
      }
    }

    res.json({ puntos: resultados });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('Servidor funcionando en puerto ' + PORT);
});
