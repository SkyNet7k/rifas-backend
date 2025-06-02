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

// RUTAS CORREGIDAS: Ahora los archivos JSON se buscan directamente en el directorio __dirname
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const COMPROBANTES_REGISTRO_FILE = path.join(__dirname, 'comprobantes.json'); // Archivo para registrar los comprobantes

// Directorio para comprobantes cargados (este seguirá siendo una subcarpeta si se usa para guardar archivos subidos)
// Si también quieres que los comprobantes subidos estén en la raíz, avísame.
const COMPROBANTES_UPLOAD_DIR = path.join(__dirname, 'comprobantes'); 


// Middlewares
app.use(cors());
app.use(express.json());
app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    abortOnLimit: true
}));

// Servir archivos estáticos desde el directorio 'comprobantes'
app.use('/comprobantes', express.static(COMPROBANTES_UPLOAD_DIR));

// Variables globales para datos (se cargarán al inicio)
let configuracion = {};
let numerosDisponibles = [];
let ventasRegistradas = [];
let horariosZulia = [];
let resultadosZulia = [];
let comprobantesRegistros = []; // Para los comprobantes cargados por clientes


// --- Funciones de utilidad para leer y escribir JSON ---
async function readJsonFile(filePath, defaultValue = []) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        const parsedData = JSON.parse(data);
        return parsedData;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Se creará con el valor por defecto.`);
            await writeJsonFile(filePath, defaultValue); // Crea un archivo vacío si no existe
            return defaultValue;
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw error; // Vuelve a lanzar el error si no es ENOENT
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir en el archivo ${filePath}:`, error);
        throw error;
    }
}

// --- Funciones para manejar autenticación y autorización (básicas) ---
function isAuthenticated(req, res, next) {
    // Implementa aquí tu lógica de autenticación (ej. verificar token)
    // Por ahora, solo para desarrollo, permite el paso.
    // En producción, esto DEBE ser seguro.
    next();
}

// --- Rutas de la API ---

// Ruta para obtener la configuración general
app.get('/configuracion', async (req, res) => {
    try {
        res.json(configuracion);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta para obtener los números disponibles
app.get('/numeros-disponibles', async (req, res) => {
    try {
        res.json(numerosDisponibles);
    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta para obtener los horarios del Zulia
app.get('/horarios-zulia', async (req, res) => {
    try {
        res.json(horariosZulia);
    } catch (error) {
        console.error('Error al obtener horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Ruta para registrar una nueva venta
app.post('/registrar-venta', async (req, res) => {
    const { comprador, telefono, numeros, valor_usd, valor_bs, metodo_pago, referencia_pago, url_comprobante } = req.body;

    if (!comprador || !telefono || !numeros || numeros.length === 0 || !metodo_pago || !valor_usd) {
        return res.status(400).json({ message: 'Faltan campos obligatorios para registrar la venta.' });
    }

    if (configuracion.bloquearPagina) {
        return res.status(403).json({ message: 'La página está bloqueada para nuevas ventas. Intenta más tarde.' });
    }

    // Verificar si los números seleccionados están disponibles
    const numerosNoDisponibles = numeros.filter(n => !numerosDisponibles.includes(n));
    if (numerosNoDisponibles.length > 0) {
        return res.status(400).json({ message: `Los siguientes números ya no están disponibles: ${numerosNoDisponibles.join(', ')}. Por favor, recarga la página y selecciona otros.` });
    }

    // Asignar un número de ticket
    const numero_ticket = configuracion.ultimoNumeroTicket + 1;

    // Obtener fecha y hora actual en la zona horaria de Venezuela
    const now = moment().tz("America/Caracas");
    const fecha_hora_compra = now.format(); // Formato ISO 8601
    const fecha_sorteo = configuracion.fechaSorteo || 'N/A'; // Usar la fecha de sorteo de la configuración
    const numero_sorteo_correlativo = configuracion.numeroSorteoCorrelativo || 1; // Usar el número de sorteo correlativo


    const nuevaVenta = {
        id: Date.now().toString(), // ID único basado en timestamp
        fecha_hora_compra,
        fecha_sorteo,
        numero_sorteo_correlativo,
        numero_ticket,
        comprador,
        telefono,
        numeros,
        valor_usd,
        valor_bs,
        metodo_pago,
        referencia_pago: referencia_pago || 'N/A',
        url_comprobante: url_comprobante || null, // Guardar la URL del comprobante si se subió
        estado: 'pendiente_pago' // Estado inicial de la venta
    };

    try {
        // Actualizar números disponibles
        numerosDisponibles = numerosDisponibles.filter(n => !numeros.includes(n));
        await writeJsonFile(NUMEROS_FILE, numerosDisponibles);

        // Registrar la venta
        ventasRegistradas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventasRegistradas);

        // Actualizar el último número de ticket en la configuración
        configuracion.ultimoNumeroTicket = numero_ticket;
        await writeJsonFile(CONFIG_FILE, configuracion);

        // Enviar correo de confirmación al cliente (opcional, si implementas la lógica de correo)
        // await enviarCorreoConfirmacion(nuevaVenta);

        res.status(201).json({ message: 'Venta registrada con éxito', venta: nuevaVenta });
    } catch (error) {
        console.error('Error al registrar venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar la venta.' });
    }
});


// --- Rutas del panel de administración ---

// Obtener todas las ventas registradas (para el panel admin)
app.get('/admin/ventas', isAuthenticated, async (req, res) => {
    try {
        res.json(ventasRegistradas);
    } catch (error) {
        console.error('Error al obtener ventas para admin:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Actualizar el precio del ticket
app.post('/admin/actualizar-precio-ticket', isAuthenticated, async (req, res) => {
    const { precio_ticket } = req.body;
    if (precio_ticket === undefined || isNaN(precio_ticket) || precio_ticket < 0) {
        return res.status(400).json({ message: 'Precio de ticket inválido.' });
    }
    try {
        configuracion.precioTicket = parseFloat(precio_ticket);
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Precio del ticket actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar precio de ticket:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Actualizar la tasa del dólar
app.post('/admin/actualizar-tasa-dolar', isAuthenticated, async (req, res) => {
    const { tasa_dolar } = req.body;
    if (tasa_dolar === undefined || isNaN(tasa_dolar) || tasa_dolar < 0) {
        return res.status(400).json({ message: 'Tasa de dólar inválida.' });
    }
    try {
        configuracion.tasaDolar = parseFloat(tasa_dolar);
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Tasa del dólar actualizada con éxito.' });
    } catch (error) {
        console.error('Error al actualizar tasa de dólar:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Actualizar la fecha del sorteo
app.post('/admin/actualizar-fecha-sorteo', isAuthenticated, async (req, res) => {
    const { fecha_sorteo } = req.body;
    // Basic validation: Check if it's a valid date string
    if (!moment(fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Fecha de sorteo inválida. Usa el formato YYYY-MM-DD.' });
    }
    try {
        configuracion.fechaSorteo = fecha_sorteo; // Guardar como string YYYY-MM-DD
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Fecha de sorteo actualizada con éxito.' });
    } catch (error) {
        console.error('Error al actualizar fecha de sorteo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Actualizar el número de sorteo correlativo
app.post('/admin/actualizar-numero-sorteo-correlativo', isAuthenticated, async (req, res) => {
    const { numero_sorteo_correlativo } = req.body;
    if (numero_sorteo_correlativo === undefined || isNaN(numero_sorteo_correlativo) || numero_sorteo_correlativo < 1) {
        return res.status(400).json({ message: 'Número de sorteo correlativo inválido.' });
    }
    try {
        configuracion.numeroSorteoCorrelativo = parseInt(numero_sorteo_correlativo);
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Número de sorteo correlativo actualizado con éxito.' });
    } catch (error) {
        console.error('Error al actualizar número de sorteo correlativo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Bloquear/desbloquear la página principal
app.post('/admin/actualizar-bloqueo-pagina', isAuthenticated, async (req, res) => {
    const { bloquear_pagina } = req.body;
    if (typeof bloquear_pagina !== 'boolean') {
        return res.status(400).json({ message: 'Valor de bloqueo de página inválido. Debe ser true o false.' });
    }
    try {
        configuracion.bloquearPagina = bloquear_pagina;
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: `Página ${bloquear_pagina ? 'bloqueada' : 'desbloqueada'} con éxito.` });
    } catch (error) {
        console.error('Error al actualizar bloqueo de página:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Rutas de administración para Horarios del Zulia
app.get('/admin/horarios-zulia', isAuthenticated, async (req, res) => {
    try {
        res.json({ horarios_zulia: horariosZulia });
    } catch (error) {
        console.error('Error al obtener horarios del Zulia para admin:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.post('/admin/agregar-horario-zulia', isAuthenticated, async (req, res) => {
    const { horario } = req.body;
    if (!horario || typeof horario !== 'string' || !/^\d{2}:\d{2}$/.test(horario)) {
        return res.status(400).json({ message: 'Formato de horario inválido. Usa HH:MM.' });
    }
    if (horariosZulia.includes(horario)) {
        return res.status(409).json({ message: 'El horario ya existe.' });
    }
    try {
        horariosZulia.push(horario);
        horariosZulia.sort(); // Opcional: ordenar los horarios
        await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        res.status(201).json({ message: 'Horario agregado con éxito.', horarios_zulia: horariosZulia });
    } catch (error) {
        console.error('Error al agregar horario del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.delete('/admin/eliminar-horario-zulia/:horario', isAuthenticated, async (req, res) => {
    const { horario } = req.params;
    const initialLength = horariosZulia.length;
    horariosZulia = horariosZulia.filter(h => h !== horario);
    if (horariosZulia.length === initialLength) {
        return res.status(404).json({ message: 'Horario no encontrado.' });
    }
    try {
        await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        res.json({ message: 'Horario eliminado con éxito.', horarios_zulia: horariosZulia });
    } catch (error) {
        console.error('Error al eliminar horario del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta para subir comprobantes de pago de clientes (admin puede acceder a ver)
app.post('/subir-comprobante', async (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se ha subido ningún archivo.' });
    }

    const comprobanteFile = req.files.comprobante;
    const { ventaId } = req.body; // Puedes enviar el ID de la venta asociado si lo tienes

    if (!ventaId) {
        return res.status(400).json({ message: 'Se requiere el ID de la venta para subir el comprobante.' });
    }

    // Generar un nombre de archivo único
    const fileName = `${ventaId}-${Date.now()}${path.extname(comprobanteFile.name)}`;
    const uploadPath = path.join(COMPROBANTES_UPLOAD_DIR, fileName);

    try {
        // Asegurarse de que el directorio de subidas exista
        await fs.mkdir(COMPROBANTES_UPLOAD_DIR, { recursive: true });
        await comprobanteFile.mv(uploadPath);

        // Guardar la referencia del comprobante en el registro de ventas
        const ventaIndex = ventasRegistradas.findIndex(v => v.id === ventaId);
        if (ventaIndex !== -1) {
            ventasRegistradas[ventaIndex].url_comprobante = `/comprobantes/${fileName}`; // Ruta pública
            ventasRegistradas[ventaIndex].estado = 'comprobante_subido';
            await writeJsonFile(VENTAS_FILE, ventasRegistradas);
        }

        // Registrar el comprobante en el nuevo archivo comprobantes.json
        const newComprobanteEntry = {
            id: Date.now().toString(),
            venta_id: ventaId,
            url: `/comprobantes/${fileName}`,
            fecha_subida: moment().tz("America/Caracas").format(),
            // Puedes añadir más detalles aquí si los obtienes de la venta original
            comprador: ventasRegistradas[ventaIndex]?.comprador || 'N/A',
            telefono: ventasRegistradas[ventaIndex]?.telefono || 'N/A',
            numeros: ventasRegistradas[ventaIndex]?.numeros || [],
            metodo_pago: ventasRegistradas[ventaIndex]?.metodo_pago || 'N/A',
            referencia_pago: ventasRegistradas[ventaIndex]?.referencia_pago || 'N/A',
            fecha_hora_compra: ventasRegistradas[ventaIndex]?.fecha_hora_compra || 'N/A',
            fecha_sorteo: ventasRegistradas[ventaIndex]?.fecha_sorteo || 'N/A',
            nro_sorteo: ventasRegistradas[ventaIndex]?.numero_sorteo_correlativo || 'N/A',
            url_comprobante_original_venta: ventasRegistradas[ventaIndex]?.url_comprobante || null // Por si ya tenía uno
        };
        comprobantesRegistros.push(newComprobanteEntry);
        await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);

        res.status(200).json({ message: 'Comprobante subido y registrado con éxito', url: `/comprobantes/${fileName}` });
    } catch (error) {
        console.error('Error al subir comprobante:', error);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.' });
    }
});


// Ruta para obtener la lista de comprobantes registrados (para el panel admin)
app.get('/admin/comprobantes-registro', isAuthenticated, async (req, res) => {
    try {
        res.json(comprobantesRegistros);
    } catch (error) {
        console.error('Error al obtener comprobantes de registro:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Endpoint para que el administrador pueda realizar el corte de ventas manual (solo email)
app.post('/admin/corte-manual-solo-email', isAuthenticated, async (req, res) => {
    try {
        // Generar el reporte de ventas en Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Ventas');

        // Columnas
        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 30 },
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 18 },
            { header: 'Números', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 40 }
        ];

        // Añadir filas
        ventasRegistradas.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: moment(venta.fecha_hora_compra).tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo_correlativo: venta.numero_sorteo_correlativo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros ? venta.numeros.join(', ') : '',
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                url_comprobante: venta.url_comprobante
            });
        });

        // Escribir el buffer del Excel
        const excelBuffer = await workbook.xlsx.writeBuffer();
        const emailSubject = `Reporte de Ventas - ${moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm')}`;

        // Configurar el transporter de Nodemailer
        const transporter = nodemailer.createTransport({
            service: 'Gmail', // Puedes usar otro servicio o SMTP
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        // Opciones del correo
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL_RECIPIENT, // Usar la variable de entorno para el destinatario
            subject: emailSubject,
            html: `
                <h1>Reporte de Ventas</h1>
                <p>Adjunto encontrarás el reporte de ventas a la fecha y hora de este correo.</p>
                <p>Fecha del Reporte: ${moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss')}</p>
                <p>Total de ventas registradas: ${ventasRegistradas.length}</p>
                <p>Gracias.</p>
            `,
            attachments: [
                {
                    filename: `Reporte_Ventas_${moment().tz("America/Caracas").format('YYYYMMDD_HHmmss')}.xlsx`,
                    content: excelBuffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ]
        };

        // Enviar el correo
        await transporter.sendMail(mailOptions);

        res.json({ message: 'Corte de ventas realizado y reporte enviado por correo con éxito.' });

    } catch (error) {
        console.error('Error al realizar el corte de ventas manual (solo email):', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar el corte de ventas.' });
    }
});


// Endpoint para exportar todas las ventas a un archivo Excel sin enviar correo
app.get('/admin/exportar-ventas-excel', isAuthenticated, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Ventas');

        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 30 },
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 18 },
            { header: 'Números', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 40 }
        ];

        ventasRegistradas.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: moment(venta.fecha_hora_compra).tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo_correlativo: venta.numero_sorteo_correlativo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros ? venta.numeros.join(', ') : '',
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                url_comprobante: venta.url_comprobante
            });
        });

        // Establecer encabezados para la descarga
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Reporte_Ventas_${moment().tz("America/Caracas").format('YYYYMMDD_HHmmss')}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar a Excel.' });
    }
});

// Rutas para gestionar resultados del Zulia (admin)
app.get('/admin/resultados-zulia', isAuthenticated, async (req, res) => {
    try {
        res.json(resultadosZulia);
    } catch (error) {
        console.error('Error al obtener resultados del Zulia para admin:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.post('/admin/agregar-resultado-zulia', isAuthenticated, async (req, res) => {
    const { fecha, sorteo, resultado } = req.body;
    if (!fecha || !sorteo || !resultado) {
        return res.status(400).json({ message: 'Faltan campos obligatorios (fecha, sorteo, resultado).' });
    }
    // Simple validación de formato (puedes mejorarla)
    if (!moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Formato de fecha inválido. Usa YYYY-MM-DD.' });
    }

    const newResult = {
        id: Date.now().toString(),
        fecha,
        sorteo,
        resultado,
        fecha_registro: moment().tz("America/Caracas").format()
    };

    try {
        resultadosZulia.push(newResult);
        await writeJsonFile(RESULTS_ZULIA_FILE, resultadosZulia);
        res.status(201).json({ message: 'Resultado agregado con éxito.', resultado: newResult });
    } catch (error) {
        console.error('Error al agregar resultado del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.delete('/admin/eliminar-resultado-zulia/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const initialLength = resultadosZulia.length;
    resultadosZulia = resultadosZulia.filter(r => r.id !== id);
    if (resultadosZulia.length === initialLength) {
        return res.status(404).json({ message: 'Resultado no encontrado.' });
    }
    try {
        await writeJsonFile(RESULTS_ZULIA_FILE, resultadosZulia);
        res.json({ message: 'Resultado eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar resultado del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Tarea programada de corte de ventas y reinicio de números (diario a las 00:00 VET)
cron.schedule('0 0 * * *', async () => { // Se ejecuta todos los días a medianoche (00:00)
    console.log('Iniciando tarea programada: corte de ventas y reinicio de números...');
    try {
        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');
        const currentDrawDate = configuracion.fechaSorteo;

        // Sólo reiniciar números y actualizar fecha de sorteo si la fecha de sorteo es hoy o anterior
        if (!currentDrawDate || moment(currentDrawDate).tz("America/Caracas").isSameOrBefore(todayFormatted, 'day')) {
            // Reiniciar números disponibles
            numerosDisponibles = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles);
            console.log('Números disponibles reiniciados.');

            // Reiniciar ventas registradas (opcional, si el corte implica borrar las ventas anteriores)
            // ventasRegistradas = [];
            // await writeJsonFile(VENTAS_FILE, ventasRegistradas);
            // console.log('Ventas registradas reiniciadas.');

            // Reiniciar el último número de ticket
            configuracion.ultimoNumeroTicket = 0;

            // Actualizar la fecha del sorteo al día siguiente y el número correlativo
            configuracion.fechaSorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');
            configuracion.numeroSorteoCorrelativo = (configuracion.numeroSorteoCorrelativo || 0) + 1;
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${configuracion.fechaSorteo} y correlativo a ${configuracion.numeroSorteoCorrelativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas" // Asegúrate de que la zona horaria sea correcta para la ejecución del cron
});


// Función de inicialización para cargar todos los datos
async function loadInitialData() {
    try {
        configuracion = await readJsonFile(CONFIG_FILE, {
            precioTicket: 1.00,
            tasaDolar: 36.5,
            ultimoNumeroTicket: 0,
            fechaSorteo: moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD'),
            numeroSorteoCorrelativo: 1,
            bloquearPagina: false
        });

        numerosDisponibles = await readJsonFile(NUMEROS_FILE, Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0')));
        if (!Array.isArray(numerosDisponibles)) numerosDisponibles = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));

        ventasRegistradas = await readJsonFile(VENTAS_FILE, []);
        if (!Array.isArray(ventasRegistradas)) ventasRegistradas = [];

        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, ["13:00", "15:00", "17:00", "19:00"]);
        if (!Array.isArray(horariosZulia)) horariosZulia = ["13:00", "15:00", "17:00", "19:00"];

        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        if (!Array.isArray(resultadosZulia)) resultadosZulia = [];

        comprobantesRegistros = await readJsonFile(COMPROBANTES_REGISTRO_FILE, []);
        if (!Array.isArray(comprobantesRegistros)) comprobantesRegistros = [];

        console.log('Datos iniciales cargados con éxito.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
        // Si hay un error crítico al cargar los datos iniciales, el servidor no debería iniciar
        throw error;
    }
}


// Inicialización del servidor
// Se eliminó ensureDataAndComprobantesDirs() ya que los archivos están en la raíz
loadInitialData().then(() => {
    app.listen(port, () => {
        console.log(`Servidor de la API escuchando en el puerto ${port}`);
        console.log(`API Base URL: ${API_BASE_URL}`);
        console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
        console.log(`Frontend principal disponible en: https://tuoportunidadeshoy.netlify.app`);
    });
}).catch(err => {
    console.error('Error crítico al iniciar el servidor:', err);
    process.exit(1); // Sale del proceso si no se pueden cargar los datos iniciales
});