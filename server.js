const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AEMET_API_KEY = process.env.AEMET_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let municipiosCache = null;
let municipiosCacheTime = 0;

const memoryCache = new Map();

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

function getCache(key) {
  const item = memoryCache.get(key);
  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    memoryCache.delete(key);
    return null;
  }

  return item.value;
}

function setCache(key, value, ttlMs) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`Error HTTP ${res.status} en ${url}`);
  }
  return res.json();
}

async function aemetStep(url, ttlMs = 10 * 60 * 1000) {
  const cached = getCache(`aemet:${url}`);
  if (cached) return cached;

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
  const parsed = tryParseJSON(text);

  setCache(`aemet:${url}`, parsed, ttlMs);
  return parsed;
}

async function getMunicipios() {
  const now = Date.now();

  if (municipiosCache && now - municipiosCacheTime < 12 * 60 * 60 * 1000) {
    return municipiosCache;
  }

  const url = 'https://opendata.aemet.es/opendata/api/maestro/municipios';
  const raw = await aemetStep(url, 12 * 60 * 60 * 1000);
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

function weatherCodeToText(code) {
  const map = {
    0: 'Despejado',
    1: 'Poco nuboso',
    2: 'Intervalos nubosos',
    3: 'Cubierto',
    45: 'Niebla',
    48: 'Niebla con cencellada',
    51: 'Llovizna débil',
    53: 'Llovizna moderada',
    55: 'Llovizna intensa',
    56: 'Llovizna helada débil',
    57: 'Llovizna helada intensa',
    61: 'Lluvia débil',
    63: 'Lluvia moderada',
    65: 'Lluvia intensa',
    66: 'Lluvia helada débil',
    67: 'Lluvia helada intensa',
    71: 'Nieve débil',
    73: 'Nieve moderada',
    75: 'Nieve intensa',
    77: 'Granitos de nieve',
    80: 'Chubascos débiles',
    81: 'Chubascos moderados',
    82: 'Chubascos fuertes',
    85: 'Chubascos de nieve débiles',
    86: 'Chubascos de nieve fuertes',
    95: 'Tormenta',
    96: 'Tormenta con granizo débil',
    99: 'Tormenta con granizo fuerte'
  };

  return map[code] || 'Sin dato';
}

async function getOpenMeteoForecast(lat, lon, forecastDays = 5) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  const daysNum = Math.min(Math.max(Number(forecastDays) || 5, 1), 7);

  const cacheKey = `openmeteo:${latNum.toFixed(4)}:${lonNum.toFixed(4)}:${daysNum}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url =
    'https://api.open-meteo.com/v1/forecast?' +
    new URLSearchParams({
      latitude: String(latNum),
      longitude: String(lonNum),
      hourly: [
        'temperature_2m',
        'precipitation_probability',
        'precipitation',
        'rain',
        'showers',
        'weather_code',
        'wind_speed_10m'
      ].join(','),
      daily: [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'wind_speed_10m_max'
      ].join(','),
      current: [
        'temperature_2m',
        'precipitation',
        'rain',
        'showers',
        'weather_code',
        'wind_speed_10m'
      ].join(','),
      timezone: 'auto',
      forecast_days: String(daysNum)
    }).toString();

  const data = await fetchJson(url);
  setCache(cacheKey, data, 15 * 60 * 1000);

  return data;
}

function pickNearestHourlyForecast(data, targetDate) {
  const hourly = data?.hourly;
  if (!hourly?.time?.length) return null;

  const targetTs = targetDate.getTime();
  let bestIndex = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < hourly.time.length; i++) {
    const ts = new Date(hourly.time[i]).getTime();
    const diff = Math.abs(ts - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }

  return {
    time: hourly.time[bestIndex],
    temperature: hourly.temperature_2m?.[bestIndex] ?? null,
    precipitationProbability: hourly.precipitation_probability?.[bestIndex] ?? null,
    precipitation: hourly.precipitation?.[bestIndex] ?? null,
    rain: hourly.rain?.[bestIndex] ?? null,
    showers: hourly.showers?.[bestIndex] ?? null,
    weatherCode: hourly.weather_code?.[bestIndex] ?? null,
    weatherText: weatherCodeToText(hourly.weather_code?.[bestIndex]),
    windSpeed: hourly.wind_speed_10m?.[bestIndex] ?? null
  };
}

function buildHourlyText(forecast, horaPaso) {
  if (!forecast) return 'Sin previsión horaria disponible';

  return (
    'Hora estimada: ' + horaPaso.toLocaleString('es-ES') + '\n' +
    'Estado del cielo: ' + forecast.weatherText + '\n' +
    'Temperatura: ' + (forecast.temperature ?? '—') + '°C\n' +
    'Probabilidad de precipitación: ' + (forecast.precipitationProbability ?? '—') + '%\n' +
    'Precipitación: ' + (forecast.precipitation ?? '—') + ' mm\n' +
    'Viento: ' + (forecast.windSpeed ?? '—') + ' km/h'
  );
}

function buildArrivalText(forecast, horaLlegada) {
  if (!forecast) return 'Sin previsión de llegada disponible';

  return (
    'Hora estimada de llegada: ' + horaLlegada.toLocaleString('es-ES') + '\n' +
    'Estado del cielo: ' + forecast.weatherText + '\n' +
    'Temperatura: ' + (forecast.temperature ?? '—') + '°C\n' +
    'Probabilidad de precipitación: ' + (forecast.precipitationProbability ?? '—') + '%\n' +
    'Precipitación: ' + (forecast.precipitation ?? '—') + ' mm\n' +
    'Viento: ' + (forecast.windSpeed ?? '—') + ' km/h'
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRiskLevel(score) {
  if (score >= 75) return 'muy alto';
  if (score >= 50) return 'alto';
  if (score >= 25) return 'moderado';
  return 'bajo';
}

function getColorFromRisk(score) {
  if (score >= 75) return 'rojo';
  if (score >= 50) return 'naranja';
  if (score >= 25) return 'amarillo';
  return 'verde';
}

function scoreFromHourlyForecast(hourlyForecast) {
  if (!hourlyForecast) {
    return {
      score: 0,
      level: 'bajo',
      color: 'verde'
    };
  }

  const prob = Number(hourlyForecast.precipitationProbability ?? 0);
  const precip = Number(hourlyForecast.precipitation ?? 0);
  const wind = Number(hourlyForecast.windSpeed ?? 0);

  let score = 0;

  score += clamp(prob * 0.6, 0, 60);
  score += clamp(precip * 10, 0, 25);
  score += clamp(wind * 0.3, 0, 15);

  score = Math.round(clamp(score, 0, 100));

  return {
    score,
    level: getRiskLevel(score),
    color: getColorFromRisk(score)
  };
}

function buildRiskSummary(nombre, hourlyForecast, horaPaso, risk) {
  return (
    'Punto: ' + nombre + '\n' +
    'Hora estimada: ' + horaPaso.toLocaleString('es-ES') + '\n' +
    'Riesgo: ' + risk.level.toUpperCase() + ' (' + risk.score + '/100)\n' +
    'Estado: ' + (hourlyForecast?.weatherText ?? 'Sin dato') + '\n' +
    'Probabilidad de precipitación: ' + (hourlyForecast?.precipitationProbability ?? '—') + '%\n' +
    'Precipitación: ' + (hourlyForecast?.precipitation ?? '—') + ' mm\n' +
    'Viento: ' + (hourlyForecast?.windSpeed ?? '—') + ' km/h'
  );
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
      'https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/' + municipio.id,
      30 * 60 * 1000
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
    const puntos = JSON.parse(req.query.puntos || '[]');
    const fechaSalidaTxt = req.query.fechaSalida || '';
    const duracionSeg = Number(req.query.duracionSeg || 0);

    if (!Array.isArray(puntos) || puntos.length === 0) {
      return res.status(400).json({ error: 'Faltan puntos de ruta' });
    }

    if (!fechaSalidaTxt) {
      return res.status(400).json({ error: 'Falta fechaSalida' });
    }

    const fechaSalida = new Date(fechaSalidaTxt);
    if (Number.isNaN(fechaSalida.getTime())) {
      return res.status(400).json({ error: 'fechaSalida inválida' });
    }

    const lastRouteIndex = Math.max(
      ...puntos.map(p => Number.isFinite(Number(p.routeIndex)) ? Number(p.routeIndex) : 0),
      1
    );

    const resultados = [];

    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];
      const lat = Number(p.lat);
      const lon = Number(p.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        resultados.push({
          nombre: p.nombre || `Punto ${i + 1}`,
          lat,
          lon,
          error: 'Coordenadas inválidas'
        });
        continue;
      }

      const progress = Number.isFinite(Number(p.routeIndex))
        ? Number(p.routeIndex) / lastRouteIndex
        : (puntos.length === 1 ? 1 : i / (puntos.length - 1));

      const horaPaso = new Date(fechaSalida.getTime() + Math.max(0, duracionSeg) * 1000 * progress);
      const forecast = await getOpenMeteoForecast(lat, lon, 5);
      const hourlyForecast = pickNearestHourlyForecast(forecast, horaPaso);

      resultados.push({
        nombre: p.nombre || `Punto ${i + 1}`,
        lat,
        lon,
        horaPaso: horaPaso.toISOString(),
        texto: buildHourlyText(hourlyForecast, horaPaso),
        avisoColor:
          (hourlyForecast?.precipitationProbability ?? 0) >= 70 ? 'naranja' :
          (hourlyForecast?.precipitationProbability ?? 0) >= 40 ? 'amarillo' : 'verde',
        temperatura: hourlyForecast?.temperature ?? null,
        probLluvia: hourlyForecast?.precipitationProbability ?? null,
        precipitacion: hourlyForecast?.precipitation ?? null,
        viento: hourlyForecast?.windSpeed ?? null,
        estado: hourlyForecast?.weatherText ?? 'Sin dato'
      });
    }

    res.json({ puntos: resultados });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/destino-meteo', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const fechaLlegadaTxt = req.query.fechaLlegada || '';
    const dias = Math.min(Math.max(Number(req.query.dias || 5), 1), 7);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'Faltan lat/lon válidos para destino' });
    }

    const fechaLlegada = fechaLlegadaTxt ? new Date(fechaLlegadaTxt) : new Date();
    if (Number.isNaN(fechaLlegada.getTime())) {
      return res.status(400).json({ error: 'fechaLlegada inválida' });
    }

    const forecast = await getOpenMeteoForecast(lat, lon, dias);
    const llegada = pickNearestHourlyForecast(forecast, fechaLlegada);

    const daily = forecast?.daily || {};
    const diasDestino = (daily.time || []).map((date, i) => ({
      fecha: date,
      estado: weatherCodeToText(daily.weather_code?.[i]),
      tempMax: daily.temperature_2m_max?.[i] ?? null,
      tempMin: daily.temperature_2m_min?.[i] ?? null,
      probLluviaMax: daily.precipitation_probability_max?.[i] ?? null,
      vientoMax: daily.wind_speed_10m_max?.[i] ?? null
    }));

    res.json({
      llegada: {
        hora: fechaLlegada.toISOString(),
        texto: buildArrivalText(llegada, fechaLlegada),
        estado: llegada?.weatherText ?? 'Sin dato',
        temperatura: llegada?.temperature ?? null,
        probLluvia: llegada?.precipitationProbability ?? null,
        precipitacion: llegada?.precipitation ?? null,
        viento: llegada?.windSpeed ?? null
      },
      dias: diasDestino
    });
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

    const raw = await aemetStep(url, 5 * 60 * 1000);
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

app.post('/api/route/analyze', async (req, res) => {
  try {
    const puntos = Array.isArray(req.body.puntos) ? req.body.puntos : [];
    const fechaSalidaTxt = req.body.fechaSalida || '';
    const duracionSeg = Number(req.body.duracionSeg || 0);

    if (!puntos.length) {
      return res.status(400).json({ error: 'Faltan puntos de ruta' });
    }

    if (!fechaSalidaTxt) {
      return res.status(400).json({ error: 'Falta fechaSalida' });
    }

    const fechaSalida = new Date(fechaSalidaTxt);
    if (Number.isNaN(fechaSalida.getTime())) {
      return res.status(400).json({ error: 'fechaSalida inválida' });
    }

    const lastRouteIndex = Math.max(
      ...puntos.map(p => Number.isFinite(Number(p.routeIndex)) ? Number(p.routeIndex) : 0),
      1
    );

    const resultados = [];

    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];
      const lat = Number(p.lat);
      const lon = Number(p.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        resultados.push({
          nombre: p.nombre || `Punto ${i + 1}`,
          lat,
          lon,
          error: 'Coordenadas inválidas'
        });
        continue;
      }

      const progress = Number.isFinite(Number(p.routeIndex))
        ? Number(p.routeIndex) / lastRouteIndex
        : (puntos.length === 1 ? 1 : i / (puntos.length - 1));

      const horaPaso = new Date(fechaSalida.getTime() + Math.max(0, duracionSeg) * 1000 * progress);
      const forecast = await getOpenMeteoForecast(lat, lon, 5);
      const hourlyForecast = pickNearestHourlyForecast(forecast, horaPaso);
      const risk = scoreFromHourlyForecast(hourlyForecast);

      resultados.push({
        nombre: p.nombre || `Punto ${i + 1}`,
        lat,
        lon,
        horaPaso: horaPaso.toISOString(),
        riesgo: risk.score,
        nivelRiesgo: risk.level,
        colorRiesgo: risk.color,
        texto: buildRiskSummary(p.nombre || `Punto ${i + 1}`, hourlyForecast, horaPaso, risk),
        temperatura: hourlyForecast?.temperature ?? null,
        probLluvia: hourlyForecast?.precipitationProbability ?? null,
        precipitacion: hourlyForecast?.precipitation ?? null,
        viento: hourlyForecast?.windSpeed ?? null,
        estado: hourlyForecast?.weatherText ?? 'Sin dato'
      });
    }

    const validos = resultados.filter(p => typeof p.riesgo === 'number');
    const riesgoMedio = validos.length
      ? Math.round(validos.reduce((acc, p) => acc + p.riesgo, 0) / validos.length)
      : 0;

    const peorTramo = validos.length
      ? validos.reduce((max, p) => p.riesgo > max.riesgo ? p : max, validos[0])
      : null;

    res.json({
      ok: true,
      salida: fechaSalida.toISOString(),
      riesgoGlobal: riesgoMedio,
      nivelGlobal: getRiskLevel(riesgoMedio),
      colorGlobal: getColorFromRisk(riesgoMedio),
      peorTramo,
      resumen:
        peorTramo
          ? `La ruta presenta riesgo ${getRiskLevel(riesgoMedio)}. El punto más comprometido es ${peorTramo.nombre} con riesgo ${peorTramo.riesgo}/100.`
          : 'No se pudo calcular el riesgo de la ruta.',
      puntos: resultados
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/route/best-departure', async (req, res) => {
  try {
    const puntos = Array.isArray(req.body.puntos) ? req.body.puntos : [];
    const fechaSalidaTxt = req.body.fechaSalida || '';
    const duracionSeg = Number(req.body.duracionSeg || 0);
    const horasVentana = Math.min(Math.max(Number(req.body.horasVentana || 6), 1), 12);
    const pasoMinutos = Math.min(Math.max(Number(req.body.pasoMinutos || 30), 15), 120);

    if (!puntos.length) {
      return res.status(400).json({ error: 'Faltan puntos de ruta' });
    }

    if (!fechaSalidaTxt) {
      return res.status(400).json({ error: 'Falta fechaSalida' });
    }

    const fechaBase = new Date(fechaSalidaTxt);
    if (Number.isNaN(fechaBase.getTime())) {
      return res.status(400).json({ error: 'fechaSalida inválida' });
    }

    const lastRouteIndex = Math.max(
      ...puntos.map(p => Number.isFinite(Number(p.routeIndex)) ? Number(p.routeIndex) : 0),
      1
    );

    const candidatos = [];

    for (let minutos = 0; minutos <= horasVentana * 60; minutos += pasoMinutos) {
      const salida = new Date(fechaBase.getTime() + minutos * 60 * 1000);
      const riesgos = [];

      for (let i = 0; i < puntos.length; i++) {
        const p = puntos[i];
        const lat = Number(p.lat);
        const lon = Number(p.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const progress = Number.isFinite(Number(p.routeIndex))
          ? Number(p.routeIndex) / lastRouteIndex
          : (puntos.length === 1 ? 1 : i / (puntos.length - 1));

        const horaPaso = new Date(salida.getTime() + Math.max(0, duracionSeg) * 1000 * progress);
        const forecast = await getOpenMeteoForecast(lat, lon, 5);
        const hourlyForecast = pickNearestHourlyForecast(forecast, horaPaso);
        const risk = scoreFromHourlyForecast(hourlyForecast);

        riesgos.push(risk.score);
      }

      const riesgoMedio = riesgos.length
        ? Math.round(riesgos.reduce((acc, n) => acc + n, 0) / riesgos.length)
        : 0;

      candidatos.push({
        salida: salida.toISOString(),
        riesgoGlobal: riesgoMedio,
        nivelGlobal: getRiskLevel(riesgoMedio),
        colorGlobal: getColorFromRisk(riesgoMedio)
      });
    }

    candidatos.sort((a, b) => a.riesgoGlobal - b.riesgoGlobal);

    const mejor = candidatos[0] || null;
    const peor = candidatos[candidatos.length - 1] || null;

    res.json({
      ok: true,
      mejor,
      peor,
      alternativas: candidatos.slice(0, 5),
      resumen:
        mejor
          ? `La mejor hora de salida es ${new Date(mejor.salida).toLocaleString('es-ES')} con riesgo ${mejor.riesgoGlobal}/100.`
          : 'No se pudo calcular la mejor hora de salida.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('Servidor funcionando en puerto ' + PORT);
});
