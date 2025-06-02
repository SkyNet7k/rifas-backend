// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone');
const ExcelJS = require('exceljs'); // Asegúrate de tener 'exceljs' instalado: npm install exceljs

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configura la URL base de tu API, preferiblemente desde variables de entorno
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

const DATA_DIR = path.join(__dirname, 'data');
const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');
const CONFIG_FILE = path.join(DATA_DIR, 'configuracion.json');
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(DATA_DIR, 'resultados_zulia.json');

// --- CORRECCIÓN AQUÍ ---
// Cambiado de 'comprobantes_registro.json' a 'comprobantes.json'
const COMPROBANTES_REGISTRO_FILE = path.join(DATA_DIR, 'comprobantes.json'); 
// -----------------------

const MAIL_CONFIG_FILE = path.join(DATA_DIR, 'mail_config.json');

let configuracion = {};
let numerosDisponibles = [];
let ventasRegistradas = [];
let horariosZulia = [];
let resultadosZulia = [];
let comprobantesRegistros = []; // Los datos de los comprobantes finales se cargarán aquí
let mailConfig = {};

// Asegura que los directorios de datos y comprobantes existan
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
        console.log('Directorios de datos y comprobantes asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios:', error);
    }
}

// Función auxiliar para leer JSON
async function readJsonFile(filePath, defaultContent = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
            return defaultContent;
        }
        throw error;
    }
}

// Función auxiliar para escribir JSON
async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload({
    createParentPath: true,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
}));

// Autenticación simple de admin (para desarrollo, considerar JWT en producción)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'your_admin_secret_key'; // Usar variable de entorno
function isAuthenticated(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ message: 'No autorizado: Token no proporcionado.' });
    }

    const token = authHeader.split(' ')[1]; // Espera "Bearer TOKEN"
    if (token === ADMIN_API_KEY) {
        next();
    } else {
        res.status(403).json({ message: 'No autorizado: Token inválido.' });
    }
}

// Carga inicial de datos desde archivos
async function loadInitialData() {
    try {
        configuracion = await readJsonFile(CONFIG_FILE, {
            precioTicket: 1,
            tasaDolar: 36,
            fechaSorteo: moment().tz("America/Caracas").format('YYYY-MM-DD'),
            numeroSorteoCorrelativo: 1,
            bloquearPagina: false,
        });

        numerosDisponibles = await readJsonFile(NUMEROS_FILE, Array.from({ length: 100 }, (_, i) => i.toString().padStart(2, '0')));
        ventasRegistradas = await readJsonFile(VENTAS_FILE, []);
        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, ["13:00", "17:00", "19:00"]);
        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        mailConfig = await readJsonFile(MAIL_CONFIG_FILE, {
            service: 'gmail', // Ejemplo: 'gmail', 'hotmail', etc.
            user: 'tu_correo@gmail.com',
            pass: 'tu_contraseña_app', // Usa una contraseña de aplicación si usas Gmail
            adminEmail: 'admin@tudominio.com',
            userEmailSubject: 'Confirmación de Compra de Ticket',
            adminEmailSubject: 'Reporte de Venta de Lotería'
        });

        // Cargar comprobantes de registro
        const dataComprobantes = await fs.readFile(COMPROBANTES_REGISTRO_FILE, 'utf8');
        comprobantesRegistros = JSON.parse(dataComprobantes);
        console.log('Comprobantes de registro cargados con éxito desde comprobantes.json.');

        console.log('Datos iniciales cargados con éxito.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
        // Si hay un error crítico al cargar algún archivo, es mejor que el servidor no inicie con datos corruptos.
        // O podrías decidir iniciar con valores predeterminados y loguear el error.
    }
}


// Rutas de la API

// --- Rutas públicas (accesibles sin autenticación, para el frontend del usuario) ---

// Obtener configuración general
app.get('/configuracion', (req, res) => {
    res.json(configuracion);
});

// Obtener números disponibles
app.get('/numeros-disponibles', (req, res) => {
    res.json(numerosDisponibles);
});

// Obtener horarios del Zulia (pública)
app.get('/horarios-zulia', (req, res) => {
    res.json({ horarios_zulia: horariosZulia });
});

// Obtener resultados del Zulia (pública)
app.get('/resultados-zulia', (req, res) => {
    res.json(resultadosZulia);
});

// Ruta para que el cliente genere un nuevo ticket (compra)
app.post('/generar-ticket', async (req, res) => {
    const { comprador, telefono, numerosSeleccionados, metodoPago, referenciaPago, urlComprobante } = req.body;

    // Validación básica
    if (!comprador || !telefono || !numerosSeleccionados || numerosSeleccionados.length === 0 || !metodoPago) {
        return res.status(400).json({ message: 'Faltan datos obligatorios para generar el ticket.' });
    }

    if (configuracion.bloquearPagina) {
        return res.status(403).json({ message: 'La página está temporalmente bloqueada para nuevas compras. Inténtalo más tarde.' });
    }

    // Calcular el valor del ticket
    const valorUSD = configuracion.precioTicket * numerosSeleccionados.length;
    const valorBs = valorUSD * configuracion.tasaDolar;

    // Verificar si los números seleccionados ya están tomados
    const numerosTomados = numerosSeleccionados.filter(num => !numerosDisponibles.includes(num));
    if (numerosTomados.length > 0) {
        return res.status(409).json({ message: `Los siguientes números ya han sido tomados: ${numerosTomados.join(', ')}. Por favor, selecciona otros.` });
    }

    // Generar número de ticket único
    const numeroTicket = Date.now().toString(); // Timestamp como número de ticket simple

    const nuevaVenta = {
        id: Date.now().toString(), // ID único para la venta
        fecha_hora_compra: moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
        fecha_sorteo: configuracion.fechaSorteo,
        numero_sorteo_correlativo: configuracion.numeroSorteoCorrelativo,
        numero_ticket: numeroTicket,
        comprador,
        telefono,
        numeros: numerosSeleccionados.sort(),
        valor_usd: valorUSD,
        valor_bs: valorBs,
        metodo_pago: metodoPago,
        referencia_pago: referenciaPago || 'N/A',
        url_comprobante: urlComprobante || null, // Guardar la URL del comprobante si se subió
        status: 'Pendiente de confirmación', // O 'Pagado' si se procesa directamente
        tipo: 'rifa' // O 'loto' si es para otro juego
    };

    ventasRegistradas.push(nuevaVenta);

    // Eliminar números vendidos de los disponibles
    numerosDisponibles = numerosDisponibles.filter(num => !numerosSeleccionados.includes(num));

    try {
        await writeJsonFile(VENTAS_FILE, ventasRegistradas);
        await writeJsonFile(NUMEROS_FILE, numerosDisponibles);

        // Enviar correo al comprador
        const transporter = nodemailer.createTransport({
            service: mailConfig.service,
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass
            }
        });

        const mailOptionsComprador = {
            from: mailConfig.user,
            to: mailConfig.userEmail, // Asumo que el correo del comprador viene en la config. O debería ser un campo en la compra?
            subject: mailConfig.userEmailSubject,
            html: `
                <p>Hola ${comprador},</p>
                <p>¡Gracias por tu compra! Aquí están los detalles de tu ticket:</p>
                <ul>
                    <li><strong>Fecha/Hora Compra:</strong> ${nuevaVenta.fecha_hora_compra}</li>
                    <li><strong>Fecha del Sorteo:</strong> ${nuevaVenta.fecha_sorteo}</li>
                    <li><strong>Número de Sorteo:</strong> ${nuevaVenta.numero_sorteo_correlativo}</li>
                    <li><strong>Número de Ticket:</strong> ${nuevaVenta.numero_ticket}</li>
                    <li><strong>Números Jugados:</strong> ${nuevaVenta.numeros.join(', ')}</li>
                    <li><strong>Valor (USD):</strong> $${nuevaVenta.valor_usd.toFixed(2)}</li>
                    <li><strong>Valor (Bs):</strong> Bs ${nuevaVenta.valor_bs.toFixed(2)}</li>
                    <li><strong>Método de Pago:</strong> ${nuevaVenta.metodo_pago}</li>
                    <li><strong>Referencia de Pago:</strong> ${nuevaVenta.referencia_pago}</li>
                    ${nuevaVenta.url_comprobante ? `<li><strong>Comprobante:</strong> <a href="${nuevaVenta.url_comprobante}">Ver Comprobante</a></li>` : ''}
                </ul>
                <p>¡Mucha suerte en el sorteo!</p>
                <p>Tu Lotería Amiga</p>
            `
        };

        // Descomenta y configura cuando tengas un correo para el comprador
        // await transporter.sendMail(mailOptionsComprador);
        // console.log('Correo de confirmación enviado al comprador.');

        res.status(201).json({
            message: 'Ticket generado con éxito. ¡Mucha suerte!',
            ticket: nuevaVenta,
            numerosDisponibles: numerosDisponibles.length
        });

    } catch (error) {
        console.error('Error al generar ticket y guardar datos:', error);
        // Si hay un error al guardar, revertir los números disponibles para evitar inconsistencias
        numerosDisponibles.push(...numerosSeleccionados);
        ventasRegistradas = ventasRegistradas.filter(v => v.id !== nuevaVenta.id);
        await writeJsonFile(NUMEROS_FILE, numerosDisponibles); // Intenta guardar de nuevo
        await writeJsonFile(VENTAS_FILE, ventasRegistradas); // Intenta guardar de nuevo
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.' });
    }
});


// Subir comprobante de pago
app.post('/subir-comprobante', fileUpload({ createParentPath: true }), async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ message: 'No se ha subido ningún archivo.' });
        }

        const comprobanteFile = req.files.comprobante;
        const uploadPath = path.join(COMPROBANTES_DIR, comprobanteFile.name);

        await comprobanteFile.mv(uploadPath);

        // Guardar el registro del comprobante finalizado
        const nuevoComprobanteRegistro = {
            venta_id: req.body.venta_id || 'N/A', // Puedes asociarlo a una venta existente
            comprador: req.body.comprador || 'N/A',
            telefono: req.body.telefono || 'N/A',
            numeros: req.body.numeros ? JSON.parse(req.body.numeros) : [], // Asegúrate de que venga como string JSON
            metodo_pago: req.body.metodo_pago || 'N/A',
            referencia_pago: req.body.referencia_pago || 'N/A',
            fecha_hora_finalizacion: moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
            url: `/comprobantes/${comprobanteFile.name}`, // URL accesible desde el frontend
            fecha_sorteo: req.body.fecha_sorteo || 'N/A',
            nro_sorteo: req.body.nro_sorteo || 'N/A',
            url_comprobante_original_venta: req.body.url_comprobante_original_venta || null // Si ya tenía una URL de comprobante
        };

        comprobantesRegistros.push(nuevoComprobanteRegistro);
        await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);

        res.json({
            message: 'Comprobante subido y registrado con éxito.',
            url: `/comprobantes/${comprobanteFile.name}`
        });

    } catch (error) {
        console.error('Error al subir comprobante:', error);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.' });
    }
});

// Servir archivos estáticos (comprobantes subidos)
app.use('/comprobantes', express.static(COMPROBANTES_DIR));


// --- Rutas de Administración (requieren autenticación) ---

// Obtener configuración general (admin)
app.get('/admin/configuracion', isAuthenticated, (req, res) => {
    res.json(configuracion);
});

// Actualizar precio del ticket
app.post('/admin/actualizar-precio-ticket', isAuthenticated, async (req, res) => {
    const { precio_ticket } = req.body;
    if (precio_ticket === undefined || isNaN(precio_ticket) || precio_ticket < 0) {
        return res.status(400).json({ message: 'Precio del ticket inválido.' });
    }
    configuracion.precioTicket = parseFloat(precio_ticket);
    await writeJsonFile(CONFIG_FILE, configuracion);
    res.json({ message: 'Precio del ticket actualizado con éxito.', configuracion });
});

// Actualizar tasa del dólar
app.post('/admin/actualizar-tasa-dolar', isAuthenticated, async (req, res) => {
    const { tasa_dolar } = req.body;
    if (tasa_dolar === undefined || isNaN(tasa_dolar) || tasa_dolar < 0) {
        return res.status(400).json({ message: 'Tasa del dólar inválida.' });
    }
    configuracion.tasaDolar = parseFloat(tasa_dolar);
    await writeJsonFile(CONFIG_FILE, configuracion);
    res.json({ message: 'Tasa del dólar actualizada con éxito.', configuracion });
});

// Actualizar fecha del sorteo
app.post('/admin/actualizar-fecha-sorteo', isAuthenticated, async (req, res) => {
    const { fecha_sorteo } = req.body;
    if (!moment(fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Formato de fecha de sorteo inválido. Usa YYYY-MM-DD.' });
    }
    configuracion.fechaSorteo = fecha_sorteo;
    await writeJsonFile(CONFIG_FILE, configuracion);
    res.json({ message: 'Fecha del sorteo actualizada con éxito.', configuracion });
});

// Actualizar número de sorteo correlativo
app.post('/admin/actualizar-numero-sorteo-correlativo', isAuthenticated, async (req, res) => {
    const { numero_sorteo_correlativo } = req.body;
    if (numero_sorteo_correlativo === undefined || isNaN(numero_sorteo_correlativo) || parseInt(numero_sorteo_correlativo) < 1) {
        return res.status(400).json({ message: 'Número de sorteo correlativo inválido.' });
    }
    configuracion.numeroSorteoCorrelativo = parseInt(numero_sorteo_correlativo);
    await writeJsonFile(CONFIG_FILE, configuracion);
    res.json({ message: 'Número de sorteo correlativo actualizado con éxito.', configuracion });
});

// Actualizar bloqueo de página
app.post('/admin/actualizar-bloqueo-pagina', isAuthenticated, async (req, res) => {
    const { bloquear_pagina } = req.body;
    if (typeof bloquear_pagina !== 'boolean') {
        return res.status(400).json({ message: 'Valor de bloqueo de página inválido.' });
    }
    configuracion.bloquearPagina = bloquear_pagina;
    await writeJsonFile(CONFIG_FILE, configuracion);
    res.json({ message: 'Estado de bloqueo de página actualizado con éxito.', configuracion });
});

// Rutas de configuración de correo (Admin)
// app.get('/admin/mail-config', isAuthenticated, (req, res) => {
//     const { pass, ...safeMailConfig } = mailConfig; // No enviar la contraseña
//     res.json(safeMailConfig);
// });

// app.post('/admin/actualizar-mail-config', isAuthenticated, async (req, res) => {
//     const { service, user, pass, adminEmail, userEmailSubject, adminEmailSubject } = req.body;

//     if (!service || !user || !pass || !adminEmail) {
//         return res.status(400).json({ message: 'Faltan campos obligatorios para la configuración de correo.' });
//     }

//     mailConfig.service = service;
//     mailConfig.user = user;
//     mailConfig.pass = pass; // Guardar la contraseña (sensible, manejar con cuidado)
//     mailConfig.adminEmail = adminEmail;
//     mailConfig.userEmailSubject = userEmailSubject || 'Confirmación de Compra de Ticket';
//     mailConfig.adminEmailSubject = adminEmailSubject || 'Reporte de Venta de Lotería';

//     await writeJsonFile(MAIL_CONFIG_FILE, mailConfig);
//     const { pass: savedPass, ...safeMailConfig } = mailConfig;
//     res.json({ message: 'Configuración de correo actualizada con éxito.', mailConfig: safeMailConfig });
// });

// Gestión de Horarios del Zulia (Admin)
app.get('/admin/horarios-zulia', isAuthenticated, (req, res) => {
    res.json({ horarios_zulia: horariosZulia });
});

app.post('/admin/agregar-horario-zulia', isAuthenticated, async (req, res) => {
    const { horario } = req.body;
    if (!horario || !/^\d{2}:\d{2}$/.test(horario)) {
        return res.status(400).json({ message: 'Formato de horario inválido. Usa HH:MM.' });
    }
    if (horariosZulia.includes(horario)) {
        return res.status(409).json({ message: 'El horario ya existe.' });
    }
    horariosZulia.push(horario);
    horariosZulia.sort(); // Mantener ordenado
    await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
    res.status(201).json({ message: 'Horario agregado con éxito.', horarios_zulia: horariosZulia });
});

app.delete('/admin/eliminar-horario-zulia/:horario', isAuthenticated, async (req, res) => {
    const { horario } = req.params;
    const initialLength = horariosZulia.length;
    horariosZulia = horariosZulia.filter(h => h !== horario);
    if (horariosZulia.length === initialLength) {
        return res.status(404).json({ message: 'Horario no encontrado.' });
    }
    await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
    res.json({ message: 'Horario eliminado con éxito.', horarios_zulia: horariosZulia });
});

// Gestión de Ventas (Admin)
app.get('/admin/ventas', isAuthenticated, (req, res) => {
    // Devuelve todas las ventas, las más recientes primero
    const ventasOrdenadas = [...ventasRegistradas].sort((a, b) => new Date(b.fecha_hora_compra) - new Date(a.fecha_hora_compra));
    res.json(ventasOrdenadas);
});


// Ruta para realizar el corte de ventas y enviar el reporte por correo
app.post('/admin/corte-manual-solo-email', isAuthenticated, async (req, res) => {
    try {
        if (ventasRegistradas.length === 0) {
            return res.status(200).json({ message: 'No hay ventas para realizar el corte y enviar el reporte.' });
        }

        const transporter = nodemailer.createTransport({
            service: mailConfig.service,
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass
            }
        });

        // Generar el reporte Excel en memoria
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Ventas');

        // Definir columnas y headers
        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 20 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Números', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 40 }
        ];

        // Añadir filas con datos de ventas
        ventasRegistradas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros: venta.numeros ? venta.numeros.join(', ') : '',
                valor_usd: venta.valor_usd ? venta.valor_usd.toFixed(2) : '',
                valor_bs: venta.valor_bs ? venta.valor_bs.toFixed(2) : ''
            });
        });

        // Escribir el workbook a un buffer
        const buffer = await workbook.xlsx.writeBuffer();

        const mailOptionsAdmin = {
            from: mailConfig.user,
            to: mailConfig.adminEmail,
            subject: `Reporte de Ventas - ${moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss')}`,
            html: `<p>Adjunto encontrarás el reporte de ventas hasta el momento.</p>`,
            attachments: [
                {
                    filename: `Reporte_Ventas_${moment().tz("America/Caracas").format('YYYYMMDD_HHmmss')}.xlsx`,
                    content: buffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ]
        };

        await transporter.sendMail(mailOptionsAdmin);
        console.log('Reporte de ventas enviado por correo al administrador.');

        res.status(200).json({ message: 'Corte de ventas realizado y reporte enviado por correo con éxito.' });

    } catch (error) {
        console.error('Error al realizar el corte de ventas o enviar correo:', error);
        res.status(500).json({ message: `Error al realizar el corte de ventas: ${error.message}` });
    }
});

// Exportar todas las ventas a Excel para descarga directa
app.get('/admin/exportar-ventas-excel', isAuthenticated, async (req, res) => {
    try {
        if (ventasRegistradas.length === 0) {
            return res.status(200).json({ message: 'No hay ventas para exportar a Excel.' });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 20 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Números', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 40 }
        ];

        ventasRegistradas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros: venta.numeros ? venta.numeros.join(', ') : '',
                valor_usd: venta.valor_usd ? venta.valor_usd.toFixed(2) : '',
                valor_bs: venta.valor_bs ? venta.valor_bs.toFixed(2) : ''
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Reporte_Ventas_${moment().tz("America/Caracas").format('YYYYMMDD_HHmmss')}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: `Error al exportar ventas: ${error.message}` });
    }
});


// Obtener comprobantes de registro (admin)
app.get('/admin/comprobantes-registro', isAuthenticated, async (req, res) => {
    try {
        res.json(comprobantesRegistros);
    } catch (error) {
        console.error('Error al obtener comprobantes de registro:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Tarea programada para realizar el corte de ventas diario
// Se ejecuta cada día a las 00:00 (medianoche) hora de Venezuela
cron.schedule('0 0 * * *', async () => {
    console.log('Iniciando tarea programada: Corte de ventas y reinicio de números/fecha.');
    try {
        // 1. Realizar el corte de ventas y enviar el reporte
        // Esta lógica ya está en '/admin/corte-manual-solo-email' o similar
        // Puedes refactorizar para llamar a una función interna o duplicar la lógica
        if (ventasRegistradas.length > 0) {
            const transporter = nodemailer.createTransport({
                service: mailConfig.service,
                auth: {
                    user: mailConfig.user,
                    pass: mailConfig.pass
                }
            });

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Reporte de Ventas Diario');

            worksheet.columns = [
                { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
                { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
                { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
                { header: 'Nro. Ticket', key: 'numero_ticket', width: 20 },
                { header: 'Comprador', key: 'comprador', width: 25 },
                { header: 'Teléfono', key: 'telefono', width: 15 },
                { header: 'Números', key: 'numeros', width: 30 },
                { header: 'Valor USD', key: 'valor_usd', width: 15 },
                { header: 'Valor Bs', key: 'valor_bs', width: 15 },
                { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
                { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
                { header: 'URL Comprobante', key: 'url_comprobante', width: 40 }
            ];

            ventasRegistradas.forEach(venta => {
                worksheet.addRow({
                    ...venta,
                    numeros: venta.numeros ? venta.numeros.join(', ') : '',
                    valor_usd: venta.valor_usd ? venta.valor_usd.toFixed(2) : '',
                    valor_bs: venta.valor_bs ? venta.valor_bs.toFixed(2) : ''
                });
            });

            const buffer = await workbook.xlsx.writeBuffer();

            const mailOptionsAdmin = {
                from: mailConfig.user,
                to: mailConfig.adminEmail,
                subject: `Reporte Diario de Ventas - ${moment().tz("America/Caracas").format('YYYY-MM-DD')}`,
                html: `<p>Adjunto encontrarás el reporte de ventas del día anterior.</p>`,
                attachments: [
                    {
                        filename: `Reporte_Ventas_Diario_${moment().tz("America/Caracas").format('YYYYMMDD')}.xlsx`,
                        content: buffer,
                        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                    }
                ]
            };

            await transporter.sendMail(mailOptionsAdmin);
            console.log('Reporte diario de ventas enviado por correo al administrador.');

            // 2. Reiniciar números disponibles
            numerosDisponibles = Array.from({ length: 100 }, (_, i) => i.toString().padStart(2, '0'));
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles);
            console.log('Números disponibles reiniciados.');

            // 3. Limpiar ventas registradas
            ventasRegistradas = [];
            await writeJsonFile(VENTAS_FILE, ventasRegistradas);
            console.log('Registro de ventas limpiado.');
        } else {
            console.log('No hay ventas para reportar o limpiar en la tarea diaria.');
        }

        // 4. Actualizar la fecha del próximo sorteo si la fecha actual es posterior a la fecha de sorteo configurada
        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');
        const currentDrawDate = configuracion.fechaSorteo;

        if (moment(todayFormatted).isSameOrAfter(currentDrawDate, 'day')) {
            configuracion.fechaSorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');
            configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${configuracion.fecha_sorteo} y correlativo a ${configuracion.numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas" // Asegúrate de que la zona horaria sea correcta para la ejecución del cron
});


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
            console.log(`Frontend principal disponible en: https://tuoportunidadeshoy.netlify.app`);
        });
    });
});