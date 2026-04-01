const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MeteoRuta - Creado por Rubén</title>
    </head>
    <body>
      <h1>MeteoRuta AEMET</h1>
      <p>Creado por Rubén</p>
      <p>App funcionando 🚀</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(\`Servidor en puerto \${PORT}\`);
});
