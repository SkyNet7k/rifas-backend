// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv'); // Se mantiene por si hay otras variables de entorno (ej. PORT, API_BASE_URL)
const moment = require('moment-timezone');
const ExcelJS = require('exceljs');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app',
        'https://tuoportunidadeshoy.netlify.app',
        'http://localhost:8080',
        'http://127.0.0.1:5500',
        'http://localhost:3000',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

const DATA_DIR = path.join(__dirname, 'data');
const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');

// Asegurarse de que los directorios existan al iniciar la aplicación
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        console.log(`Directorio de datos creado o ya existe: ${DATA_DIR}`);
    } catch (error) {
        console.error(`Error al crear el directorio de datos: ${DATA_DIR}`, error);
        process.exit(1); // Sale de la aplicación si no se pueden crear los directorios críticos
    }
    try {
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
        console.log(`Directorio de comprobantes creado o ya existe: ${COMPROBANTES_DIR}`);
    } catch (error) {
        console.error(`Error al crear el directorio de comprobantes: ${COMPROBANTES_DIR}`, error);
        process.exit(1); // Sale de la aplicación si no se pueden crear los directorios críticos
    }
}

// Rutas a los archivos JSON
const CONFIG_FILE = path.join(DATA_DIR, 'configuracion.json');
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horariosZulia.json');
const RESULTADOS_ZULIA_FILE = path.join(DATA_DIR, 'resultadosZulia.json');

// --- Valores por defecto para la inicialización ---
// **Nota:** Los valores de mail_config aquí se usarán SOLO si el archivo configuracion.json no existe
// y es creado con estos valores por defecto. Si configuracion.json ya existe, se leerán sus valores.
const DEFAULT_CONFIG = {
    tasa_dolar: 36.5,
    pagina_bloqueada: false,
    fecha_sorteo: moment().tz("America/Caracas").format('YYYY-MM-DD'),
    precio_ticket: 1.00,
    numero_sorteo_correlativo: 1,
    ultimo_numero_ticket: 0,
    ultima_fecha_resultados_zulia: null,
    admin_whatsapp_numbers: ["584124723776", "584126083355", "584143630488"],
    mail_config: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: "tu_email@gmail.com", // ¡Placeholder! El archivo configuracion.json real se leerá.
        pass: "tu_contraseña_de_app", // ¡Placeholder! El archivo configuracion.json real se leerá.
        senderName: "Sistema de Rifas"
    },
    admin_email_for_reports: "tu_email_admin@gmail.com" // ¡Placeholder! El archivo configuracion.json real se leerá.
};

const DEFAULT_NUMEROS = Array.from({ length: 1000 }, (_, i) => ({
    numero: i.toString().padStart(3, '0'),
    comprado: false
}));

const DEFAULT_HORARIOS_ZULIA = {
    horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"]
};

const DEFAULT_RESULTADOS_ZULIA = [];

// --- Funciones de Utilidad para Archivos JSON ---
async function writeJsonFile(filePath, data) {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true }); // Asegura que el directorio exista
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`[ERROR] Falló la escritura en el archivo JSON ${filePath}:`, error);
        throw error; // Propagar el error si la escritura falla
    }
}

async function readJsonFile(filePath, defaultContent = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[INFO] Archivo no encontrado: ${filePath}. Creando con contenido por defecto.`);
            try {
                await writeJsonFile(filePath, defaultContent);
            } catch (writeError) {
                console.error(`[CRITICAL] Falló la creación del archivo por defecto ${filePath} después de ENOENT:`, writeError);
            }
            return defaultContent;
        } else {
            console.error(`[ERROR] Error al leer archivo JSON ${filePath}:`, error);
            throw error;
        }
    }
}

// --- Manejo Global de Errores no Capturados (MUY IMPORTANTE) ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION] Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION] Uncaught Exception:', err);
    process.exit(1);
});


// --- Carga inicial de datos al iniciar el servidor ---
let config = DEFAULT_CONFIG; // Se inicializa con valores por defecto
let numerosDisponibles = DEFAULT_NUMEROS;
let ventas = [];
let horariosZulia = DEFAULT_HORARIOS_ZULIA;
let resultadosZulia = DEFAULT_RESULTADOS_ZULIA;

async function loadInitialData() {
    try {
        // Al leer configuracion.json, si existe, sus valores SOBRESCRIBIRÁN los DEFAULT_CONFIG
        config = await readJsonFile(CONFIG_FILE, DEFAULT_CONFIG);
        console.log('Configuración cargada correctamente.');

        numerosDisponibles = await readJsonFile(NUMEROS_FILE, DEFAULT_NUMEROS);
        console.log('Números disponibles cargados correctamente.');

        ventas = await readJsonFile(VENTAS_FILE, []);
        console.log('Ventas cargadas correctamente.');

        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, DEFAULT_HORARIOS_ZULIA);
        console.log('Horarios del Zulia cargados correctamente.');

        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, DEFAULT_RESULTADOS_ZULIA);
        console.log('Resultados del Zulia cargados correctamente.');

    } catch (error) {
        console.error('Error FATAL durante la carga inicial de datos del servidor:', error);
        process.exit(1);
    }
}


// --- Rutas de la API ---

// Configuración
app.get('/api/configuracion', (req, res) => {
    try {
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ success: false, message: 'Error al obtener la configuración.' });
    }
});

app.post('/api/configuracion', async (req, res) => {
    try {
        const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo, ultimo_numero_ticket, admin_whatsapp_numbers, admin_email_for_reports, mail_config } = req.body;

        if (tasa_dolar !== undefined) config.tasa_dolar = parseFloat(tasa_dolar);
        if (pagina_bloqueada !== undefined) config.pagina_bloqueada = Boolean(pagina_bloqueada);
        if (fecha_sorteo) config.fecha_sorteo = fecha_sorteo;
        if (precio_ticket !== undefined) config.precio_ticket = parseFloat(precio_ticket);
        if (numero_sorteo_correlativo !== undefined) config.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo, 10);
        if (ultimo_numero_ticket !== undefined) config.ultimo_numero_ticket = parseInt(ultimo_numero_ticket, 10);
        if (admin_whatsapp_numbers !== undefined) config.admin_whatsapp_numbers = admin_whatsapp_numbers;
        if (admin_email_for_reports !== undefined) config.admin_email_for_reports = admin_email_for_reports;
        // Permite actualizar mail_config directamente desde el body si es necesario
        if (mail_config !== undefined && typeof mail_config === 'object') {
            config.mail_config = { ...config.mail_config, ...mail_config };
        }


        await writeJsonFile(CONFIG_FILE, config);
        res.json({ success: true, message: 'Configuración actualizada correctamente.', config });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar la configuración.' });
    }
});

// Números
app.get('/api/numeros', (req, res) => {
    try {
        res.json(numerosDisponibles);
    } catch (error) {
        console.error('Error al obtener números:', error);
        res.status(500).json({ success: false, message: 'Error al obtener los números disponibles.' });
    }
});

app.post('/api/numeros/comprar', async (req, res) => {
    try {
        const { numerosSeleccionados, comprador, telefono, metodoPago, referenciaPago, valorUsd, valorBs, fechaCompra, numeroTicket } = req.body;
        const sorteoData = {
            fecha_sorteo: config.fecha_sorteo,
            numero_sorteo_correlativo: config.numero_sorteo_correlativo
        };

        const nuevaVenta = {
            id: Date.now().toString(), // ID único para la venta
            fecha_hora_compra: fechaCompra || moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
            fecha_sorteo: sorteoData.fecha_sorteo,
            numero_sorteo: sorteoData.numero_sorteo_correlativo,
            numero_ticket: numeroTicket,
            comprador: comprador,
            telefono: telefono,
            numeros: numerosSeleccionados,
            valor_usd: valorUsd,
            valor_bs: valorBs,
            metodo_pago: metodoPago,
            referencia_pago: referenciaPago,
            comprobante_url: null // Se llenará si se sube un comprobante
        };

        const numerosNoDisponibles = [];
        numerosSeleccionados.forEach(num => {
            const index = numerosDisponibles.findIndex(n => n.numero === num && !n.comprado);
            if (index !== -1) {
                numerosDisponibles[index].comprado = true;
            } else {
                numerosNoDisponibles.push(num);
            }
        });

        if (numerosNoDisponibles.length > 0) {
            return res.status(400).json({ success: false, message: `Algunos números no están disponibles: ${numerosNoDisponibles.join(', ')}` });
        }

        ventas.push(nuevaVenta);
        config.ultimo_numero_ticket = numeroTicket; // Actualiza el último número de ticket usado

        await writeJsonFile(NUMEROS_FILE, numerosDisponibles);
        await writeJsonFile(VENTAS_FILE, ventas);
        await writeJsonFile(CONFIG_FILE, config); // Guarda el último número de ticket

        res.status(201).json({ success: true, message: 'Números comprados y venta registrada correctamente.', venta: nuevaVenta });
    } catch (error) {
        console.error('Error al procesar la compra de números:', error);
        res.status(500).json({ success: false, message: 'Error interno al procesar la compra.', error: error.message });
    }
});

app.post('/api/comprobantes/subir/:ventaId', async (req, res) => {
    try {
        const { ventaId } = req.params;
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ success: false, message: 'No se ha subido ningún archivo.' });
        }

        const comprobanteFile = req.files.comprobante;
        const uploadPath = path.join(COMPROBANTES_DIR, comprobanteFile.name);

        await comprobanteFile.mv(uploadPath);

        const ventaIndex = ventas.findIndex(v => v.id === ventaId);
        if (ventaIndex !== -1) {
            ventas[ventaIndex].comprobante_url = `${API_BASE_URL}/comprobantes/${comprobanteFile.name}`;
            await writeJsonFile(VENTAS_FILE, ventas);
            return res.json({ success: true, message: 'Comprobante subido y asociado a la venta.', url: ventas[ventaIndex].comprobante_url });
        } else {
            // Eliminar el archivo subido si no se puede asociar a una venta
            await fs.unlink(uploadPath);
            return res.status(404).json({ success: false, message: 'Venta no encontrada para asociar el comprobante.' });
        }
    } catch (error) {
        console.error('Error al subir el comprobante:', error);
        res.status(500).json({ success: false, message: 'Error al subir el comprobante.', error: error.message });
    }
});

app.use('/comprobantes', express.static(COMPROBANTES_DIR)); // Servir archivos estáticos desde el directorio de comprobantes


// Ventas
app.get('/api/ventas', (req, res) => {
    try {
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ success: false, message: 'Error al obtener las ventas.' });
    }
});

app.post('/api/ventas/corte-ventas', async (req, res) => {
    try {
        // Reiniciar números a 'comprado: false'
        numerosDisponibles = DEFAULT_NUMEROS;
        await writeJsonFile(NUMEROS_FILE, numerosDisponibles);

        // Opcional: mover las ventas actuales a un archivo de "historial" o procesarlas
        const ventasDelCorte = [...ventas]; // Copia de las ventas antes de reiniciarlas
        ventas = []; // Reiniciar el array de ventas
        await writeJsonFile(VENTAS_FILE, ventas);

        // Reiniciar el último número de ticket correlativo
        config.ultimo_numero_ticket = 0;
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
        config.fecha_sorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD'); // Actualiza la fecha del sorteo a mañana

        await writeJsonFile(CONFIG_FILE, config);

        // Preparar y enviar correo de reporte
        const emailSubject = `Reporte de Ventas del Sorteo #${ventasDelCorte[0]?.numero_sorteo || 'N/A'} - ${ventasDelCorte[0]?.fecha_sorteo || 'N/A'}`;
        const emailText = `Se ha realizado el corte de ventas. Se adjunta el archivo Excel con el detalle de las ventas.`;

        // Generar Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        // Columnas
        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 30 },
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números Comprados', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
            { header: 'Comprobante URL', key: 'comprobante_url', width: 50 }
        ];

        // Añadir filas
        ventasDelCorte.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: venta.fecha_hora_compra,
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo: venta.numero_sorteo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros.join(', '),
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                comprobante_url: venta.comprobante_url
            });
        });

        // Escribir a un buffer para adjuntar
        const excelBuffer = await workbook.xlsx.writeBuffer();

        const emailHtml = `
            <p>Se ha realizado el corte de ventas del sorteo.</p>
            <p>Puedes encontrar el detalle de las ventas en el archivo adjunto.</p>
            <p>Saludos,</p>
            <p>Tu Sistema de Rifas</p>
        `;

        // Se llama a sendSalesEmail y ahora solo usará la configuración de 'config'
        await sendSalesEmail(config, emailSubject, emailText, emailHtml, excelBuffer, 'Reporte_Ventas.xlsx');

        res.json({ success: true, message: 'Corte de ventas realizado, números reiniciados, ventas eliminadas y correo de reporte enviado.' });
    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ success: false, message: 'Error al realizar el corte de ventas.', error: error.message });
    }
});

app.get('/api/ventas/exportar-excel', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Todas las Ventas');

        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 30 },
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números Comprados', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
            { header: 'Comprobante URL', key: 'comprobante_url', width: 50 }
        ];

        ventas.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: venta.fecha_hora_compra,
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo: venta.numero_sorteo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros.join(', '),
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                comprobante_url: venta.comprobante_url
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'Todas_Ventas_Sistema_Rifas.xlsx');
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ success: false, message: 'Error al exportar ventas a Excel.', error: error.message });
    }
});


// Horarios Zulia
app.get('/api/horarios-zulia', (req, res) => {
    try {
        res.json(horariosZulia);
    } catch (error) {
        console.error('Error al obtener horarios del Zulia:', error);
        res.status(500).json({ success: false, message: 'Error al obtener los horarios del Zulia.' });
    }
});

app.post('/api/horarios-zulia', async (req, res) => {
    try {
        const { horarios_zulia } = req.body;
        if (Array.isArray(horarios_zulia)) {
            horariosZulia.horarios_zulia = horarios_zulia;
            await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
            res.json({ success: true, message: 'Horarios del Zulia actualizados correctamente.', horarios: horariosZulia.horarios_zulia });
        } else {
            res.status(400).json({ success: false, message: 'El formato de los horarios es incorrecto. Debe ser un array.' });
        }
    } catch (error) {
        console.error('Error al actualizar horarios del Zulia:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar los horarios del Zulia.' });
    }
});


// Resultados Zulia
app.get('/api/resultados-zulia', (req, res) => {
    try {
        res.json(resultadosZulia);
    } catch (error) {
        console.error('Error al obtener resultados del Zulia:', error);
        res.status(500).json({ success: false, message: 'Error al obtener los resultados del Zulia.' });
    }
});

app.post('/api/resultados-zulia', async (req, res) => {
    try {
        const { fecha, resultados } = req.body;
        if (!fecha || !Array.isArray(resultados)) {
            return res.status(400).json({ success: false, message: 'Formato de datos de resultados incorrecto.' });
        }

        // Buscar si ya existe un resultado para esta fecha
        const existingIndex = resultadosZulia.findIndex(r => r.fecha === fecha);
        if (existingIndex !== -1) {
            resultadosZulia[existingIndex].resultados = resultados; // Actualizar
        } else {
            resultadosZulia.push({ fecha, resultados }); // Añadir nuevo
        }

        config.ultima_fecha_resultados_zulia = fecha; // Actualizar la última fecha de resultados en la configuración
        await writeJsonFile(CONFIG_FILE, config); // Guardar configuración actualizada

        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);
        res.json({ success: true, message: 'Resultados del Zulia actualizados correctamente.', resultados: { fecha, resultados } });
    } catch (error) {
        console.error('Error al actualizar resultados del Zulia:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar los resultados del Zulia.' });
    }
});


// --- Funciones de Correo Electrónico ---
async function sendSalesEmail(currentConfig, subject, text, html, attachmentBuffer = null, attachmentFilename = null) {
    // ESTA FUNCIÓN AHORA SOLO UTILIZA LA CONFIGURACIÓN DE CORREO DESDE EL OBJETO 'config'
    // IGNORANDO LAS VARIABLES DE ENTORNO PARA EL CORREO.
    const emailHost = currentConfig.mail_config.host;
    const emailPort = currentConfig.mail_config.port;
    const emailSecure = currentConfig.mail_config.secure;
    const emailUser = currentConfig.mail_config.user;
    const emailPass = currentConfig.mail_config.pass;
    const emailFrom = currentConfig.mail_config.senderName;
    const adminReportEmail = currentConfig.admin_email_for_reports;

    // Validación de credenciales de correo
    if (!emailHost || !emailUser || !emailPass || !adminReportEmail) {
        console.error('ERROR CRÍTICO: Configuración de correo electrónico incompleta en configuracion.json. No se puede enviar el correo.');
        throw new Error('Configuración de correo electrónico incompleta en configuracion.json.');
    }

    try {
        const transporter = nodemailer.createTransport({
            host: emailHost,
            port: emailPort,
            secure: emailSecure,
            auth: {
                user: emailUser,
                pass: emailPass,
            },
        });

        const mailOptions = {
            from: `${emailFrom} <${emailUser}>`,
            to: adminReportEmail,
            subject: subject,
            text: text,
            html: html,
        };

        if (attachmentBuffer && attachmentFilename) {
            mailOptions.attachments = [{
                filename: attachmentFilename,
                content: attachmentBuffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }];
        }

        const info = await transporter.sendMail(mailOptions);
        console.log('Correo enviado: %s', info.messageId);
        return true;
    } catch (error) {
        console.error('Error al enviar correo de ventas:', error);
        throw error;
    }
}


// --- Tarea programada para corte de ventas y reinicio ---
cron.schedule('0 0 * * *', async () => { // Todos los días a medianoche (00:00) en la zona horaria de Caracas
    console.log('Ejecutando tarea programada de corte de ventas y reinicio...');
    try {
        const now = moment().tz("America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');
        const currentDrawDate = config.fecha_sorteo;

        // Solo reiniciar si la fecha del sorteo actual es HOY o anterior
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted)) {
            const ventasParaReporte = [...ventas];
            ventas = [];
            await writeJsonFile(VENTAS_FILE, ventas);
            console.log('Ventas reiniciadas (vacías) para el próximo sorteo.');

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Ventas del Sorteo');

            worksheet.columns = [
                { header: 'ID Venta', key: 'id', width: 30 },
                { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
                { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
                { header: 'Nro. Sorteo', key: 'numero_sorteo', width: 15 },
                { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
                { header: 'Comprador', key: 'comprador', width: 30 },
                { header: 'Teléfono', key: 'telefono', width: 20 },
                { header: 'Números Comprados', key: 'numeros', width: 30 },
                { header: 'Valor USD', key: 'valor_usd', width: 15 },
                { header: 'Valor Bs', key: 'valor_bs', width: 15 },
                { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
                { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
                { header: 'Comprobante URL', key: 'comprobante_url', width: 50 }
            ];

            ventasParaReporte.forEach(venta => {
                worksheet.addRow({
                    id: venta.id,
                    fecha_hora_compra: venta.fecha_hora_compra,
                    fecha_sorteo: venta.fecha_sorteo,
                    numero_sorteo: venta.numero_sorteo,
                    numero_ticket: venta.numero_ticket,
                    comprador: venta.comprador,
                    telefono: venta.telefono,
                    numeros: venta.numeros.join(', '),
                    valor_usd: venta.valor_usd,
                    valor_bs: venta.valor_bs,
                    metodo_pago: venta.metodo_pago,
                    referencia_pago: venta.referencia_pago,
                    comprobante_url: venta.comprobante_url
                });
            });

            const excelBuffer = await workbook.xlsx.writeBuffer();
            const emailSubject = `Reporte Automático de Ventas - Sorteo ${currentDrawDate}`;
            const emailText = `Este es el reporte automático de ventas para el sorteo del día ${currentDrawDate}.`;
            const emailHtml = `<p>Adjunto el reporte de ventas del sorteo automático para la fecha ${currentDrawDate}.</p>`;

            // Se llama a sendSalesEmail y ahora solo usará la configuración de 'config'
            await sendSalesEmail(config, emailSubject, emailText, emailHtml, excelBuffer, 'Reporte_Ventas_Automatico.xlsx');
            console.log('Reporte de ventas por correo enviado automáticamente.');

            // Reiniciar números disponibles
            numerosDisponibles = DEFAULT_NUMEROS;
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles);
            console.log('Números disponibles reiniciados automáticamente para el próximo sorteo.');

            // Actualizar la fecha del próximo sorteo a mañana y el correlativo
            config.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD');
            config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1;
            config.ultimo_numero_ticket = 0; // Reiniciar el último número de ticket usado
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas"
});


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app/`);
            console.log(`Plataforma de usuario disponible en: https://tuoportunidadeshoy.netlify.app/`);
        });
    });
});