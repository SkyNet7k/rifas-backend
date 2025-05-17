const express = require('express');
const { Pool } = require('pg');
const fileUpload = require('express-fileupload'); // Importa el middleware
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000; // Usar el puerto proporcionado por Render o 3000 por defecto

const CONFIG_FILE_PATH = path.join(__dirname, 'configuracion.json');
const HORARIOS_FILE_PATH = path.join(__dirname, 'horarios_zulia.json');

async function leerConfiguracion() {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error al leer la configuración:', error);
    return { tasa_dolar: 0, pagina_bloqueada: false }; // Valores por defecto
  }
}

async function guardarConfiguracion(config) {
  try {
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
    console.log('Configuración guardada exitosamente.');
    return true;
  } catch (error) {
    console.error('Error al guardar la configuración:', error);
    return false;
  }
}

async function leerHorariosZulia() {
  try {
    const data = await fs.readFile(HORARIOS_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error al leer los horarios del Zulia:', error);
    return { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] }; // Valores por defecto
  }
}

async function guardarHorariosZulia(horarios) {
  try {
    await fs.writeFile(HORARIOS_FILE_PATH, JSON.stringify(horarios, null, 2), 'utf8');
    console.log('Horarios del Zulia guardados exitosamente.');
    return true;
  } catch (error) {
    console.error('Error al guardar los horarios del Zulia:', error);
    return false;
  }
}

// Middleware para analizar el cuerpo de las peticiones JSON
app.use(express.json());
app.use(fileUpload()); // Agrega el middleware para manejar la carga de archivos

// Configuración de la conexión a la base de datos PostgreSQL usando variables de entorno
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432, // Asegurarse de que el puerto sea un número
  ssl: {
    rejectUnauthorized: false
  }
});

// Nuevas rutas para la configuración (almacenada en archivo)
app.get('/api/admin/configuracion', async (req, res) => {
  const config = await leerConfiguracion();
  res.json(config);
});

app.put('/api/admin/configuracion', async (req, res) => {
  const { tasa_dolar, pagina_bloqueada } = req.body;
  const config = await leerConfiguracion();
  config.tasa_dolar = tasa_dolar !== undefined ? parseFloat(tasa_dolar) : config.tasa_dolar;
  config.pagina_bloqueada = pagina_bloqueada !== undefined ? Boolean(pagina_bloqueada) : config.pagina_bloqueada;

  if (await guardarConfiguracion(config)) {
    res.json({ message: 'Configuración actualizada exitosamente' });
  } else {
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

// Nuevas rutas para los horarios del Zulia (almacenados en archivo)
app.get('/api/admin/horarios-zulia', async (req, res) => {
  const horarios = await leerHorariosZulia();
  res.json(horarios);
});

app.put('/api/admin/horarios-zulia', async (req, res) => {
  const { horarios_zulia } = req.body;
  if (Array.isArray(horarios_zulia)) {
    if (await guardarHorariosZulia({ horarios_zulia })) {
      res.json({ message: 'Horarios del Zulia actualizados exitosamente' });
    } else {
      res.status(500).json({ error: 'Error al guardar los horarios del Zulia' });
    }
  } else {
    res.status(400).json({ error: 'El formato de los horarios debe ser un array.' });
  }
});

// API para crear un nuevo usuario
app.post('/api/admin/usuarios', async (req, res) => {
  const { nombre, apellido, email, contrasena, telefono, rol } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, apellido, email, contrasena, telefono, rol) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, nombre, apellido, email, telefono, fecha_registro, rol',
      [nombre, apellido, email, contrasena, telefono, rol]
    );
    const newUser = result.rows[0];
    res.status(201).json({ message: 'Usuario creado exitosamente', usuario: newUser });
  } catch (err) {
    console.error('Error al crear el usuario', err);
    res.status(500).json({ error: 'Error al crear el usuario' });
  }
});

// API para obtener la lista de todos los usuarios
app.get('/api/admin/usuarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nombre, apellido, email, telefono, fecha_registro, rol FROM usuarios');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener la lista de usuarios', err);
    res.status(500).json({ error: 'Error al obtener la lista de usuarios' });
  }
});

// API para obtener los detalles de un usuario por su ID
app.get('/api/admin/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT id, nombre, apellido, email, telefono, fecha_registro, rol FROM usuarios WHERE id = $1', [id]);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: `No se encontró el usuario con ID ${id}` });
    }
  } catch (err) {
    console.error(`Error al obtener el usuario con ID ${id}`, err);
    res.status(500).json({ error: `Error al obtener el usuario con ID ${id}` });
  }
});

// API para actualizar la información de un usuario existente por su ID
app.put('/api/admin/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, email, contrasena, telefono, rol } = req.body;
  try {
    const result = await pool.query(
      'UPDATE usuarios SET nombre = $1, apellido = $2, email = $3, contrasena = $4, telefono = $5, rol = $6 WHERE id = $7 RETURNING id, nombre, apellido, email, telefono, fecha_registro, rol',
      [nombre, apellido, email, contrasena, telefono, rol, id]
    );
    if (result.rowCount > 0) {
      const updatedUser = result.rows[0];
      res.json({ message: 'Usuario actualizado exitosamente', usuario: updatedUser });
    } else {
      res.status(404).json({ error: `No se encontró el usuario con ID ${id}` });
    }
  } catch (err) {
    console.error(`Error al actualizar el usuario con ID ${id}`, err);
    res.status(500).json({ error: `Error al actualizar el usuario con ID ${id}` });
  }
});

// API para eliminar un usuario por su ID
app.delete('/api/admin/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    if (result.rowCount > 0) {
      res.json({ message: 'Usuario eliminado exitosamente' });
    } else {
      res.status(404).json({ error: `No se encontró el usuario con ID ${id}` });
    }
  } catch (err) {
    console.error(`Error al eliminar el usuario con ID ${id}`, err);
    res.status(500).json({ error: `Error al eliminar el usuario con ID ${id}` });
  }
});

// API para obtener la lista de todas las rifas
app.get('/api/admin/rifas', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nombre, descripcion, precio_ticket, cantidad_tickets, tickets_vendidos, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio, estado FROM rifas');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener la lista de rifas', err);
    res.status(500).json({ error: 'Error al obtener la lista de rifas' });
  }
});

// API para obtener los detalles de una rifa por su ID
app.get('/api/admin/rifas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM rifas WHERE id = $1', [id]);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: `No se encontró la rifa con ID ${id}` });
    }
  } catch (err) {
    console.error(`Error al obtener la rifa con ID ${id}`, err);
    res.status(500).json({ error: `Error al obtener la rifa con ID ${id}` });
  }
});

// API para crear una nueva rifa
app.post('/api/admin/rifas', async (req, res) => {
  const { nombre, descripcion, precio_ticket, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO rifas (nombre, descripcion, precio_ticket, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [nombre, descripcion, precio_ticket, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio]
    );
    const response = { message: 'Rifa creada exitosamente', id: result.rows[0].id };
    console.log('Respuesta POST /api/admin/rifas:', response); // Log agregado
    res.status(201).json(response);
  } catch (err) {
    console.error('Error al crear la rifa', err);
    res.status(500).json({ error: 'Error al crear la rifa' });
  }
});

// API para actualizar los detalles de una rifa existente por su ID
app.put('/api/admin/rifas/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, precio_ticket, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio, estado, numero_ganador } = req.body;
  try {
    const result = await pool.query(
      'UPDATE rifas SET nombre = $1, descripcion = $2, precio_ticket = $3, cantidad_tickets = $4, fecha_inicio = $5, fecha_fin = $6, fecha_sorteo = $7, premio = $8, imagen_premio = $9, estado = $10, numero_ganador = $11 WHERE id = $12',
      [nombre, descripcion, precio_ticket, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio, estado, numero_ganador, id]
    );
    if (result.rowCount > 0) {
      const response = { message: 'Rifa actualizada exitosamente' };
      console.log('Respuesta PUT /api/admin/rifas/:id:', response); // Log agregado
      res.json(response);
    } else {
      res.status(404).json({ error: `No se encontró la rifa con ID ${id}` });
    }
  } catch (err) {
    console.error(`Error al actualizar la rifa con ID ${id}`, err);
    res.status(500).json({ error: `Error al actualizar la rifa con ID ${id}` });
  }
});

// API para eliminar una rifa por su ID
app.delete('/api/admin/rifas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM rifas WHERE id = $1', [id]);
    if (result.rowCount > 0) {
      res.json({ message: 'Rifa eliminada exitosamente' });
    } else {
      res.status(404).json({ error: `No se encontró la rifa con ID ${id}` });
    }
  } catch (err) {
    console.error(`Error al eliminar la rifa con ID ${id}`, err);
    res.status(500).json({ error: `Error al eliminar la rifa con ID ${id}` });
  }
});

// API para registrar una nueva compra
app.post('/api/compras', async (req, res) => {
  const { numeros, comprador, telefono, valorTotalUsd, valorTotalBs, tasaAplicada, fechaCompra, fechaSorteo } = req.body;
  const comprobante = req.files && req.files.comprobante; // Acceder al archivo adjunto

  if (!numeros || numeros.length === 0 || !comprador || !telefono || !comprobante) {
    return res.status(400).json({ error: 'Faltan datos obligatorios para la compra.' });
  }

  try {
    // 1. Guardar la información de la compra en la base de datos
    const resultCompra = await pool.query(
      'INSERT INTO compras (comprador, telefono, numeros_seleccionados, valor_usd, valor_bs, tasa_aplicada, fecha_compra, fecha_sorteo, comprobante_nombre, comprobante_tipo, comprobante_datos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
      [comprador, telefono, JSON.stringify(numeros), valorTotalUsd, valorTotalBs, tasaAplicada, fechaCompra, fechaSorteo, comprobante.name, comprobante.mimetype, comprobante.data]
    );
    const compraId = resultCompra.rows[0].id;

    // 2. (Opcional) Aquí podrías agregar lógica para actualizar el estado de los números comprados si tienes una tabla de números.

    res.status(201).json({ message: 'Compra registrada exitosamente', compraId: compraId });

  } catch (error) {
    console.error('Error al registrar la compra:', error);
    res.status(500).json({ error: 'Error al registrar la compra.' });
  }
});

// Tu ruta de ejemplo existente
app.get('/', (req, res) => {
  res.send('¡Hola desde el backend de tu proyecto de Rifas y Loterias!');
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});