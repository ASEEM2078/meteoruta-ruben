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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function fetchWithRetry(url, options = {}, retries = 2, waitMs = 1200) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429) {
        lastError = new Error(`Error HTTP 429 en ${url}`);
        if (attempt < retries) {
          await sleep(waitMs * (attempt + 1));
          continue;
        }
      }

      if (!res.ok) {
        throw new Error(`Error HTTP ${res.status} en ${url}`);
      }

      return res;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(waitMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error(`Error de red en ${url}`);
}

async function aemetStep(url, ttlMs = 10 * 60 * 1000) {
  const cacheKey = `aemet:${url}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  if (!AEMET_API_KEY) {
    throw new Error('Falta AEMET_API_KEY en Render');
  }

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        accept: 'application/json',
        api_key: AEMET_API_KEY
      }
    },
    2,
    1500
  );

  const meta = await res.json();

  if (!meta.datos) {
    throw new Error('AEMET no devolvió URL de datos');
  }

  await sleep(350);

  const dataRes = await fetchWithRetry(meta.datos, {}, 2, 1500);
  const text = await dataRes.text();
  const parsed = tryParseJSON(text);

  setCache(cacheKey, parsed, ttlMs);
  return parsed;
}

async function getMunicipios() {
  const now = Date.now();

  if (municipiosCache && now - municipiosCacheTime < 24 * 60 * 60 * 1000) {
    return municipiosCache;
  }

  const url = 'https://opendata.aemet.es/opendata/api/maestro/municipios';
  const raw = await aemetStep(url, 24 * 60 * 60 * 1000);
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
  setCache(cacheKey, data, 20 * 60 * 1000);

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

function penalizacionAviso(nivel) {
  if (nivel === 'rojo') return 50;
  if (nivel === 'naranja') return 30;
  if (nivel === 'amarillo') return 15;
  return 0;
}

const PROVINCE_ALIASES = {
  alicante: ['alicante', 'alacant', 'alicantino', 'alicantina'],
  castellon: ['castellon', 'castello', 'castellonense'],
  valencia: ['valencia', 'valenciana', 'valenciano'],
  murcia: ['murcia', 'murciano', 'murciana'],
  albacete: ['albacete', 'albaceteno', 'albacetena'],
  cuenca: ['cuenca', 'conquense'],
  madrid: ['madrid', 'madrileno', 'madrilena'],
  toledo: ['toledo', 'toledano', 'toledana'],
  almeria: ['almeria', 'almeriense'],
  granada: ['granada', 'granadino', 'granadina'],
  barcelona: ['barcelona', 'barcelones', 'barcelonesa'],
  tarragona: ['tarragona', 'tarraconense'],
  lleida: ['lleida', 'lerida', 'leridano', 'leridana'],
  girona: ['girona', 'gerona', 'gerundense'],
  zaragoza: ['zaragoza', 'zaragozano', 'zaragozana'],
  teruel: ['teruel', 'turolense'],
  huesca: ['huesca', 'oscense'],
  sevilla: ['sevilla', 'sevillano', 'sevillana'],
  cordoba: ['cordoba', 'cordobes', 'cordobesa'],
  jaen: ['jaen', 'jiennense'],
  malaga: ['malaga', 'malagueno', 'malaguena', 'malagueno', 'malaguena'],
  cadiz: ['cadiz', 'gaditano', 'gaditana', 'gaditanos', 'gaditanas', 'estrecho'],
  huelva: ['huelva', 'onubense'],
  badajoz: ['badajoz', 'pacense'],
  caceres: ['caceres', 'cacereno', 'cacerena', 'cacereño', 'cacereña']
};

function getProvinceAliases(provincia) {
  const key = normalizeText(provincia);
  return PROVINCE_ALIASES[key] || [key];
}

function textoContieneProvincia(texto, provincia) {
  const t = normalizeText(texto);
  return getProvinceAliases(provincia).some(alias => t.includes(normalizeText(alias)));
}

function extraerProvinciaDesdeTexto(nombre) {
  const t = normalizeText(nombre);

  for (const provincia of Object.keys(PROVINCE_ALIASES)) {
    if (textoContieneProvincia(t, provincia)) {
      return provincia;
    }
  }

  return null;
}

function extraerProvinciasRutaDesdePuntos(puntos) {
  const set = new Set();

  for (const p of puntos) {
    const provincia = extraerProvinciaDesdeTexto(p.nombre || '');
    if (provincia) set.add(provincia);
  }

  return Array.from(set);
}

function avisoCoincideConProvincia(aviso, provincia) {
  const texto = normalizeText(
    [aviso.areaDesc, aviso.headline, aviso.description, aviso.event].join(' ')
  );

  return textoContieneProvincia(texto, provincia);
}

function avisoParaPunto(punto, avisos) {
  const nombre = normalizeText(punto.nombre || '');
  const provinciaPunto = extraerProvinciaDesdeTexto(punto.nombre || '');

  let mejor = null;
  let mejorScore = -1;

  for (const aviso of avisos) {
    const area = normalizeText(aviso.areaDesc || '');
    const headline = normalizeText(aviso.headline || '');
    const description = normalizeText(aviso.description || '');
    const event = normalizeText(aviso.event || '');

    const texto = [area, headline, description, event].join(' ').trim();
    if (!texto) continue;

    let score = 0;

    if (provinciaPunto && avisoCoincideConProvincia(aviso, provinciaPunto)) {
      score += 100;
    }

    if (nombre && area && (nombre.includes(area) || area.includes(nombre))) {
      score += 80;
    }

    const tokensNombre = nombre.split(' ').filter(w => w.length >= 5);
    const coincidencias = tokensNombre.filter(tok => texto.includes(tok)).length;
    score += coincidencias * 8;

    if (score > mejorScore) {
      mejor = aviso;
      mejorScore = score;
    }
  }

  return mejorScore >= 60 ? mejor : null;
}

function buildRiskSummary(nombre, hourlyForecast, horaPaso, risk, aviso = null) {
  return (
    'Punto: ' + nombre + '\n' +
    'Hora estimada: ' + horaPaso.toLocaleString('es-ES') + '\n' +
    'Riesgo: ' + risk.level.toUpperCase() + ' (' + risk.score + '/100)\n' +
    'Estado: ' + (hourlyForecast?.weatherText ?? 'Sin dato') + '\n' +
    'Probabilidad de precipitación: ' + (hourlyForecast?.precipitationProbability ?? '—') + '%\n' +
    'Precipitación: ' + (hourlyForecast?.precipitation ?? '—') + ' mm\n' +
    'Viento: ' + (hourlyForecast?.windSpeed ?? '—') + ' km/h' +
    (aviso ? '\nAviso oficial: ' + (aviso.nivel || 'sin nivel') + ' - ' + (aviso.event || 'Aviso meteorológico') : '')
  );
}

async function getAvisosParaRuta(fechaSalida, puntos, provinciasEntrada = []) {
  if (!AEMET_API_KEY) return [];

  const provinciasDetectadas = provinciasEntrada.length
    ? provinciasEntrada.map(normalizeText).filter(Boolean)
    : extraerProvinciasRutaDesdePuntos(puntos);

  try {
    const provParam = provinciasDetectadas.length
      ? '&provincias=' + encodeURIComponent(provinciasDetectadas.join(','))
      : '';
    const fechaParam = '&fecha=' + encodeURIComponent(fechaSalida.toISOString());

    const avisosUrl = `http://127.0.0.1:${PORT}/api/avisos-oficiales?area=esp${provParam}${fechaParam}`;
    const avisosRes = await fetchJson(avisosUrl);
    return avisosRes.avisos || [];
  } catch {
    return [];
  }
}

async function analyzeRouteCore({ puntos, fechaSalida, duracionSeg, provincias = [] }) {
  const avisos = await getAvisosParaRuta(fechaSalida, puntos, provincias);

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

    let risk = scoreFromHourlyForecast(hourlyForecast);
    const aviso = avisoParaPunto(p, avisos);

    if (aviso) {
      risk.score = clamp(risk.score + penalizacionAviso(aviso.nivel), 0, 100);
      risk.level = getRiskLevel(risk.score);
      risk.color = getColorFromRisk(risk.score);
    }

    resultados.push({
      nombre: p.nombre || `Punto ${i + 1}`,
      lat,
      lon,
      horaPaso: horaPaso.toISOString(),
      riesgo: risk.score,
      nivelRiesgo: risk.level,
      colorRiesgo: risk.color,
      aviso: aviso || null,
      texto: buildRiskSummary(p.nombre || `Punto ${i + 1}`, hourlyForecast, horaPaso, risk, aviso),
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

  return {
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
  };
}

async function bestDepartureCore({ puntos, fechaBase, duracionSeg, horasVentana, pasoMinutos, provincias = [] }) {
  const lastRouteIndex = Math.max(
    ...puntos.map(p => Number.isFinite(Number(p.routeIndex)) ? Number(p.routeIndex) : 0),
    1
  );

  const candidatos = [];

  for (let minutos = 0; minutos <= horasVentana * 60; minutos += pasoMinutos) {
    const salida = new Date(fechaBase.getTime() + minutos * 60 * 1000);
    const avisos = await getAvisosParaRuta(salida, puntos, provincias);
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

      let risk = scoreFromHourlyForecast(hourlyForecast);
      const aviso = avisoParaPunto(p, avisos);

      if (aviso) {
        risk.score = clamp(risk.score + penalizacionAviso(aviso.nivel), 0, 100);
      }

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

  return {
    ok: true,
    mejor,
    peor,
    alternativas: candidatos.slice(0, 5),
    resumen:
      mejor
        ? `La mejor hora de salida es ${new Date(mejor.salida).toLocaleString('es-ES')} con riesgo ${mejor.riesgoGlobal}/100.`
        : 'No se pudo calcular la mejor hora de salida.'
  };
}

function buildSmartDecision(analysis, bestDeparture) {
  const riesgoActual = Number(analysis?.riesgoGlobal ?? 0);
  const riesgoMejor = Number(bestDeparture?.mejor?.riesgoGlobal ?? riesgoActual);
  const peor = analysis?.peorTramo || null;
  const aviso = peor?.aviso || null;

  let decision = 'seguir';
  let recomendacion = 'Ruta aceptable en este momento.';
  let motivo = 'Sin incidencias críticas.';
  let accion = 'Puedes salir con vigilancia normal.';

  if (riesgoActual >= 80 || (aviso && aviso.nivel === 'rojo')) {
    decision = 'evitar';
    recomendacion = 'No recomendable iniciar la ruta ahora.';
    motivo = aviso
      ? `Hay un aviso ${aviso.nivel} en el tramo más conflictivo.`
      : 'El riesgo global es extremadamente alto.';
    accion = bestDeparture?.mejor && riesgoMejor + 15 < riesgoActual
      ? `Conviene retrasar la salida hasta las ${new Date(bestDeparture.mejor.salida).toLocaleString('es-ES')}.`
      : 'Conviene posponer la ruta y revisar más tarde.';
  } else if (bestDeparture?.mejor && riesgoMejor + 10 < riesgoActual) {
    decision = 'salir_mas_tarde';
    recomendacion = 'Conviene retrasar la salida.';
    motivo = `La mejor salida reduce el riesgo de ${riesgoActual}/100 a ${riesgoMejor}/100.`;
    accion = `Hora recomendada: ${new Date(bestDeparture.mejor.salida).toLocaleString('es-ES')}.`;
  } else if (riesgoActual >= 55) {
    decision = 'precaucion_alta';
    recomendacion = 'Puedes salir, pero con mucha precaución.';
    motivo = 'La ruta tiene varios puntos de riesgo elevado.';
    accion = 'Revisa el radar, reduce velocidad y vigila el tramo peor valorado.';
  }

  return {
    decision,
    recomendacion,
    motivo,
    accion
  };
}

app.get('/api/municipio-prediccion', async (req, res) => {
  try {
    const lugar = req.query.lugar;
    if (!lugar) {
      return res.status(400).json({ error: 'Falta parámetro lugar' });
    }

    if (!AEMET_API_KEY) {
      return res.json({
        municipio: lugar,
        provincia: '',
        resumen: {
          texto: 'Predicción AEMET no disponible ahora mismo.',
          avisoColor: 'verde'
        }
      });
    }

    const municipios = await getMunicipios();
    const municipio = escogerMunicipio(lugar, municipios);

    if (!municipio) {
      return res.status(404).json({ error: 'No se encontró municipio AEMET para ' + lugar });
    }

    try {
      const data = await aemetStep(
        'https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/' + municipio.id,
        60 * 60 * 1000
      );

      const pred = Array.isArray(data) ? data[0] : data;
      const resumen = extraerResumenPrediccion(pred);

      return res.json({
        municipio: municipio.nombre,
        provincia: municipio.provincia,
        resumen
      });
    } catch (error) {
      return res.json({
        municipio: municipio.nombre,
        provincia: municipio.provincia,
        resumen: {
          texto: 'Predicción AEMET temporalmente no disponible. Intenta de nuevo en unos minutos.',
          avisoColor: 'verde'
        },
        aemetTemporalmenteNoDisponible: true
      });
    }
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
      return res.json({
        ok: true,
        totalAvisos: 0,
        activos: 0,
        relacionados: 0,
        avisos: [],
        aemetTemporalmenteNoDisponible: true
      });
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

    let raw;
    try {
      raw = await aemetStep(url, 15 * 60 * 1000);
    } catch (error) {
      return res.json({
        ok: true,
        totalAvisos: 0,
        activos: 0,
        relacionados: 0,
        avisos: [],
        aemetTemporalmenteNoDisponible: true
      });
    }

    const xml = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const avisos = parseAvisosCapXML(xml);

    const activos = avisos.filter(a => avisoActivoEnHora(a, fechaSalida));

    const relacionados = activos.filter(a => {
      if (!provincias.length) return true;
      return provincias.some(p => avisoCoincideConProvincia(a, p));
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
    const provincias = Array.isArray(req.body.provincias) ? req.body.provincias : [];

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

    const analysis = await analyzeRouteCore({
      puntos,
      fechaSalida,
      duracionSeg,
      provincias
    });

    res.json(analysis);
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
    const provincias = Array.isArray(req.body.provincias) ? req.body.provincias : [];

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

    const best = await bestDepartureCore({
      puntos,
      fechaBase,
      duracionSeg,
      horasVentana,
      pasoMinutos,
      provincias
    });

    res.json(best);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/route/intelligent', async (req, res) => {
  try {
    const puntos = Array.isArray(req.body.puntos) ? req.body.puntos : [];
    const fechaSalidaTxt = req.body.fechaSalida || '';
    const duracionSeg = Number(req.body.duracionSeg || 0);
    const horasVentana = Math.min(Math.max(Number(req.body.horasVentana || 6), 1), 12);
    const pasoMinutos = Math.min(Math.max(Number(req.body.pasoMinutos || 30), 15), 120);
    const provincias = Array.isArray(req.body.provincias) ? req.body.provincias : [];

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

    const analysis = await analyzeRouteCore({
      puntos,
      fechaSalida,
      duracionSeg,
      provincias
    });

    const bestDeparture = await bestDepartureCore({
      puntos,
      fechaBase: fechaSalida,
      duracionSeg,
      horasVentana,
      pasoMinutos,
      provincias
    });

    const smart = buildSmartDecision(analysis, bestDeparture);

    res.json({
      ok: true,
      smart,
      analisisActual: analysis,
      mejorSalida: bestDeparture.mejor || null,
      alternativasSalida: bestDeparture.alternativas || [],
      tramosCriticos: (analysis.puntos || [])
        .filter(p => Number(p.riesgo || 0) >= 60)
        .map(p => ({
          nombre: p.nombre,
          horaPaso: p.horaPaso,
          riesgo: p.riesgo,
          nivelRiesgo: p.nivelRiesgo,
          aviso: p.aviso || null,
          estado: p.estado,
          probLluvia: p.probLluvia,
          precipitacion: p.precipitacion,
          viento: p.viento
        }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('Servidor funcionando en puerto ' + PORT);
});
