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

function tryParseJSON(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ensureArray(value) {
  const parsed = tryParseJSON(value);

  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.datos)) return parsed.datos;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  if (parsed && Array.isArray(parsed.municipios)) return parsed.municipios;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;

  return null;
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

  const text = await dataRes.text();
  return tryParseJSON(text);
}

async function getMunicipios() {
  const now = Date.now();

  if (municipiosCache && now - municipiosCacheTime < 12 * 60 * 60 * 1000) {
    return municipiosCache;
  }

  const url = 'https://opendata.aemet.es/opendata/api/maestro/municipios';
  const raw = await aemetStep(url);
  const arr = ensureArray(raw);

  if (!arr) {
    throw new Error('No se pudo interpretar la lista de municipios de AEMET');
  }

  municipiosCache = arr.map(item => ({
    id: String(item.id || item.idema || '').replace(/^id/i, ''),
    nombre: item.nombre || item.nombreMunicipio || '',
    nombreNorm: normalizeText(item.nombre || item.nombreMunicipio || ''),
    provincia: item.provincia || ''
  })).filter(m => m.id && m.nombre);

  municipiosCacheTime = now;
  return municipiosCache;
}

function escogerMunicipio(texto, municipios) {
  const raw = (texto || '').split(',')[0].trim();
  const norm = normalizeText(raw);

  let exact = municipios.find(m => m.nombreNorm === norm);
  if (exact) return exact;

  let starts = municipios.find(m => m.nombreNorm.startsWith(norm));
  if (starts) return starts;

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

  if (!Number.isNaN(lluviaNum) && lluviaNum >= 70) {
    avisoColor = 'naranja';
  } else if (!Number.isNaN(lluviaNum) && lluviaNum >= 40) {
    avisoColor = 'amarillo';
  }

  const texto =
    'Estado del cielo: ' + estado + '\n' +
    'Temperatura mínima: ' + tempMin + '°C\n' +
    'Temperatura máxima: ' + tempMax + '°C\n' +
    'Probabilidad de precipitación: ' + probLluvia + '%\n' +
    'Viento: ' + viento + ' km/h';

  return {
    texto,
    avisoColor,
    tempMin,
    tempMax,
    probLluvia,
    estado
  };
}

function decodeXml(str) {
  return (str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extraerTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return decodeXml(m ? m[1] : '');
}

function parseFechaAemet(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  if (isNaN(d.getTime())) return null;
  return d;
}

function avisoActivoEnHora(aviso, fechaSalida) {
  const inicio = parseFechaAemet(aviso.onset);
  const fin = parseFechaAemet(aviso.expires);

  if (!fechaSalida) return true;
  if (!inicio && !fin) return true;
  if (inicio && fechaSalida < inicio) return false;
  if (fin && fechaSalida > fin) return false;

  return true;
}

function nivelDesdeAviso(aviso) {
  const t = normalizeText(
    [aviso.severity, aviso.headline, aviso.description, aviso.event].join(' ')
  );

  if (t.includes('extreme') || t.includes('rojo')) return 'rojo';
  if (t.includes('severe') || t.includes('naranja')) return 'naranja';
  if (t.includes('moderate') || t.includes('amarillo')) return 'amarillo';
  return 'verde';
}

function parseAvisosCapXML(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') return [];
  if (!xmlText.includes('<info')) return [];

  const bloques = xmlText.match(/<info\b[\s\S]*?<\/info>/gi) || [];

  return bloques.map(block => ({
    areaDesc: extraerTag(block, 'areaDesc'),
    event: extraerTag(block, 'event'),
    headline: extraerTag(block, 'headline'),
    description: extraerTag(block, 'description'),
    severity: extraerTag(block, 'severity'),
    onset: extraerTag(block, 'onset'),
    expires: extraerTag(block, 'expires')
  })).filter(a => a.areaDesc || a.event || a.description || a.headline);
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

app.get('/api/avisos-oficiales', async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: 'Falta AEMET_API_KEY en Render' });
    }

    const area = req.query.area || 'esp';
    const fechaTxt = req.query.fecha || '';
    const fechaSalida = fechaTxt ? new Date(fechaTxt) : null;
    const provincias = String(req.query.provincias || '')
      .split(',')
      .map(s => normalizeText(s))
      .filter(Boolean);

    const url =
      'https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/' + area;

    const raw = await aemetStep(url);
    const xml = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const avisos = parseAvisosCapXML(xml);

    const activos = avisos.filter(a => avisoActivoEnHora(a, fechaSalida));

    const relacionados = activos.filter(a => {
      const texto = normalizeText(
        [a.areaDesc, a.headline, a.description, a.event].join(' ')
      );

      if (!provincias.length) return true;
      return provincias.some(p => texto.includes(p));
    });

    const salida = relacionados.map(a => ({
      ...a,
      nivel: nivelDesdeAviso(a)
    }));

    res.json({
      ok: true,
      totalAvisos: avisos.length,
      activos: activos.length,
      relacionados: salida.length,
      avisos: salida
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('Servidor funcionando en puerto ' + PORT);
});
