// ================== IMPORTS ==================
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ================== CONFIG ==================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================== UTILS ==================
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

// ================== OPEN METEO ==================
async function getForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability,precipitation,wind_speed_10m,weather_code&forecast_days=3`;
  const res = await fetch(url);
  return res.json();
}

function pickHour(data, date) {
  const times = data.hourly.time;
  let best = 0;
  let diff = Infinity;

  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i]);
    const currentDiff = Math.abs(d - date);
    if (currentDiff < diff) {
      diff = currentDiff;
      best = i;
    }
  }

  return {
    prob: data.hourly.precipitation_probability[best] || 0,
    precip: data.hourly.precipitation[best] || 0,
    wind: data.hourly.wind_speed_10m[best] || 0
  };
}

function calcularRiesgo(f) {
  let score = 0;
  score += clamp(f.prob * 0.6, 0, 60);
  score += clamp(f.precip * 10, 0, 25);
  score += clamp(f.wind * 0.3, 0, 15);
  score = Math.round(score);

  return {
    score,
    nivel: getRiskLevel(score),
    color: getColorFromRisk(score)
  };
}

// ================== ANALYZE ==================
app.post('/api/route/analyze', async (req, res) => {
  try {
    const { puntos, fechaSalida, duracionSeg } = req.body;

    const salida = new Date(fechaSalida);
    const resultados = [];

    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];

      const progreso = i / (puntos.length - 1);
      const hora = new Date(salida.getTime() + duracionSeg * 1000 * progreso);

      const forecast = await getForecast(p.lat, p.lon);
      const f = pickHour(forecast, hora);
      const riesgo = calcularRiesgo(f);

      resultados.push({
        ...p,
        horaPaso: hora,
        riesgo: riesgo.score,
        nivelRiesgo: riesgo.nivel,
        colorRiesgo: riesgo.color,
        probLluvia: f.prob,
        precipitacion: f.precip,
        viento: f.wind
      });
    }

    const media = Math.round(
      resultados.reduce((a, b) => a + b.riesgo, 0) / resultados.length
    );

    const peor = resultados.reduce((a, b) =>
      b.riesgo > a.riesgo ? b : a
    );

    res.json({
      ok: true,
      riesgoGlobal: media,
      nivelGlobal: getRiskLevel(media),
      colorGlobal: getColorFromRisk(media),
      peorTramo: peor,
      puntos: resultados
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================== BEST DEPARTURE ==================
app.post('/api/route/best-departure', async (req, res) => {
  try {
    const { puntos, fechaSalida, duracionSeg } = req.body;

    const base = new Date(fechaSalida);
    const candidatos = [];

    for (let m = 0; m <= 360; m += 30) {
      const salida = new Date(base.getTime() + m * 60000);
      let riesgos = [];

      for (let i = 0; i < puntos.length; i++) {
        const p = puntos[i];
        const progreso = i / (puntos.length - 1);
        const hora = new Date(salida.getTime() + duracionSeg * 1000 * progreso);

        const forecast = await getForecast(p.lat, p.lon);
        const f = pickHour(forecast, hora);
        riesgos.push(calcularRiesgo(f).score);
      }

      const media = Math.round(riesgos.reduce((a, b) => a + b, 0) / riesgos.length);

      candidatos.push({
        salida,
        riesgoGlobal: media,
        nivelGlobal: getRiskLevel(media)
      });
    }

    candidatos.sort((a, b) => a.riesgoGlobal - b.riesgoGlobal);

    res.json({
      ok: true,
      mejor: candidatos[0],
      alternativas: candidatos.slice(0, 5)
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================== RUTA INTELIGENTE ==================
app.post('/api/route/intelligent', async (req, res) => {
  try {
    const { puntos, fechaSalida, duracionSeg } = req.body;

    const base = new Date(fechaSalida);

    const resultados = [];

    for (let m = 0; m <= 360; m += 30) {
      const salida = new Date(base.getTime() + m * 60000);
      let riesgos = [];

      for (let i = 0; i < puntos.length; i++) {
        const p = puntos[i];
        const progreso = i / (puntos.length - 1);
        const hora = new Date(salida.getTime() + duracionSeg * 1000 * progreso);

        const forecast = await getForecast(p.lat, p.lon);
        const f = pickHour(forecast, hora);
        riesgos.push(calcularRiesgo(f).score);
      }

      const media = Math.round(riesgos.reduce((a, b) => a + b, 0) / riesgos.length);

      resultados.push({
        salida,
        riesgoGlobal: media,
        nivelGlobal: getRiskLevel(media)
      });
    }

    resultados.sort((a, b) => a.riesgoGlobal - b.riesgoGlobal);

    res.json({
      ok: true,
      mejor: resultados[0],
      peor: resultados[resultados.length - 1],
      alternativas: resultados.slice(0, 5)
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================== SERVER ==================
app.listen(PORT, () => {
  console.log('Servidor funcionando en puerto ' + PORT);
});
