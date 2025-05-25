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

const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json'); // Asegurarse de que esta constante esté definida

async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado en ${filePath}. Creando archivo vacío.`);
            if (filePath.includes('ventas.json') || filePath.includes('numeros.json') || filePath.includes('cortes.json')) {
                return []; // Array vacío para ventas y números
            }
            return {}; // Objeto vacío por defecto para configuración y horarios
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw error;
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

let transporter;
let ADMIN_EMAIL_FOR_REPORTS;

async function initializeEmailConfig() {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        const mailConfig = config.mail_config;
        ADMIN_EMAIL_FOR_REPORTS = config.admin_email_for_reports;

        transporter = nodemailer.createTransport({
            host: mailConfig.host,
            port: mailConfig.port,
            secure: mailConfig.secure,
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass,
            },
        });
        console.log('✅ Configuración de correo cargada desde configuracion.json');
        console.log('EMAIL_HOST:', mailConfig.host ? '*****' : 'NO CONFIGURADO');
        console.log('EMAIL_PORT:', mailConfig.port ? '*****' : 'NO CONFIGURADO');
        console.log('EMAIL_USER:', mailConfig.user ? mailConfig.user : 'NO CONFIGURADO');
        console.log('EMAIL_PASS:', mailConfig.pass ? '*****' : 'NO CONFIGURADO');
        console.log('EMAIL_SECURE:', mailConfig.secure);
        console.log('ADMIN_EMAIL_FOR_REPORTS:', ADMIN_EMAIL_FOR_REPORTS ? ADMIN_EMAIL_FOR_REPORTS : 'NO CONFIGURADO');

    } catch (error) {
        console.error('❌ Error al cargar la configuración de correo desde configuracion.json:', error);
        transporter = null;
        ADMIN_EMAIL_FOR_REPORTS = 'error@example.com';
    }
}

async function sendEmailWithAttachment(to, subject, text, html, attachment) {
    if (!transporter) {
        console.error('❌ No se puede enviar correo: Transporter de Nodemailer no inicializado.');
        return false;
    }
    try {
        const config = await readJsonFile(CONFIG_FILE);
        const mailConfig = config.mail_config;

        const mailOptions = {
            from: {
                name: mailConfig.senderName || 'Sistema de Rifas',
                address: mailConfig.user
            },
            to: to,
            subject: subject,
            text: text,
            html: html,
            attachments: attachment ? [attachment] : [],
        };
        await transporter.sendMail(mailOptions);
        console.log(`✅ Correo enviado a ${to} con adjunto.`);
        return true;
    } catch (error) {
        console.error(`❌ Error al enviar correo a ${to} con adjunto:`, error);
        if (error.response) {
            console.error('SMTP Response:', error.response);
        }
        if (error.responseCode) {
            console.error('SMTP Response Code:', error.responseCode);
        }
        return false;
    }
}

// --- Rutas de API para Configuración General (ADMIN y CLIENTE) ---

// Obtener configuración general (CLIENTE - sin /admin)
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// Obtener configuración general (ADMIN - con /admin)
app.get('/api/admin/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// Actualizar configuración general (ADMIN)
app.put('/api/admin/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        const currentConfig = await readJsonFile(CONFIG_FILE);
        const updatedConfig = {
            ...currentConfig,
            tasa_dolar: newConfig.tasa_dolar !== undefined ? parseFloat(newConfig.tasa_dolar) : currentConfig.tasa_dolar,
            pagina_bloqueada: newConfig.pagina_bloqueada !== undefined ? newConfig.pagina_bloqueada : currentConfig.pagina_bloqueada,
            fecha_sorteo: newConfig.fecha_sorteo || currentConfig.fecha_sorteo,
            precio_ticket: newConfig.precio_ticket !== undefined ? parseFloat(newConfig.precio_ticket) : currentConfig.precio_ticket,
            numero_sorteo_correlativo: newConfig.numero_sorteo_correlativo !== undefined ? parseInt(newConfig.numero_sorteo_correlativo) : currentConfig.numero_sorteo_correlativo,
            ultimo_numero_ticket: newConfig.ultimo_numero_ticket !== undefined ? parseInt(newConfig.ultimo_numero_ticket) : currentConfig.ultimo_numero_ticket,
            ultima_fecha_resultados_zulia: newConfig.ultima_fecha_resultados_zulia || currentConfig.ultima_fecha_resultados_zulia,
            admin_whatsapp_numbers: newConfig.admin_whatsapp_numbers || currentConfig.admin_whatsapp_numbers,
            mail_config: newConfig.mail_config || currentConfig.mail_config,
            admin_email_for_reports: newConfig.admin_email_for_reports || currentConfig.admin_email_for_reports
        };
        await writeJsonFile(CONFIG_FILE, updatedConfig);
        await initializeEmailConfig(); // Re-inicializar la configuración de correo
        res.json({ message: 'Configuración actualizada exitosamente', config: updatedConfig });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});

// --- Rutas de API para Horarios Zulia (ADMIN y CLIENTE) ---

// Obtener horarios de Zulia (CLIENTE - sin /admin)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
});

// Obtener horarios de Zulia (ADMIN - con /admin)
app.get('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
});

// Actualizar horarios de Zulia (ADMIN)
app.put('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const newHorarios = req.body;
        await writeJsonFile(HORARIOS_ZULIA_FILE, newHorarios);
        res.json({ message: 'Horarios de Zulia actualizados exitosamente', horarios: newHorarios });
    } catch (error) {
        console.error('Error al actualizar horarios de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar horarios.' });
    }
});

// --- Rutas de API para Ventas ---

// Guardar una nueva venta
app.post('/api/ventas', async (req, res) => {
    try {
        let nuevaVenta = req.body;
        let ventas = await readJsonFile(VENTAS_FILE);
        if (!Array.isArray(ventas)) {
            ventas = [];
        }

        const config = await readJsonFile(CONFIG_FILE);
        let ultimoNumeroTicket = config.ultimo_numero_ticket || 0;

        const currentMoment = moment().tz("America/Caracas");
        nuevaVenta.id = Date.now().toString();
        nuevaVenta.fecha = currentMoment.format('YYYY-MM-DD');
        nuevaVenta.hora = currentMoment.format('HH:mm:ss');
        nuevaVenta.numero_ticket = ++ultimoNumeroTicket;

        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);

        config.ultimo_numero_ticket = ultimoNumeroTicket;
        await writeJsonFile(CONFIG_FILE, config);

        res.status(201).json({ message: 'Venta guardada exitosamente', venta: nuevaVenta });
    } catch (error) {
        console.error('Error al guardar venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al guardar venta.' });
    }
});

// Obtener todas las ventas (ADMIN)
app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.' });
    }
});

// --- Rutas de API para Números (CLIENTE) ---
// Obtener todos los números disponibles (asumiendo que numeros.json contiene los números)
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE);
        res.json(numeros);
    } catch (error) {
        console.error('Error al obtener números:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.' });
    }
});


async function getSalesForCurrentCut(currentTime = moment().tz("America/Caracas")) {
    const ventas = await readJsonFile(VENTAS_FILE);
    const config = await readJsonFile(CONFIG_FILE);

    const lastCutTime = config.last_sales_cut_timestamp ?
        moment(config.last_sales_cut_timestamp).tz("America/Caracas") :
        moment(currentTime).startOf('day');

    return ventas.filter(venta => {
        const ventaDateTime = moment(`${venta.fecha} ${venta.hora}`).tz("America/Caracas");
        return ventaDateTime.isSameOrAfter(lastCutTime) && ventaDateTime.isSameOrBefore(currentTime);
    });
}

async function getDailySales(date = moment().tz("America/Caracas")) {
    const ventas = await readJsonFile(VENTAS_FILE);
    const formattedDate = date.format('YYYY-MM-DD');
    return ventas.filter(venta => venta.fecha === formattedDate);
}

async function generateSalesExcel(salesData, cutType = 'corte') {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte de Ventas');

    worksheet.mergeCells('A1:F1');
    worksheet.getCell('A1').value = `Reporte de Ventas - ${cutType === 'corte' ? 'Corte' : 'Diario'}`;
    worksheet.getCell('A1').font = { bold: true, size: 16 };
    worksheet.getCell('A1').alignment = { horizontal: 'center' };

    worksheet.mergeCells('A2:F2');
    worksheet.getCell('A2').value = `Fecha: ${moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss')}`;
    worksheet.getCell('A2').alignment = { horizontal: 'center' };
    worksheet.getCell('A2').font = { italic: true };

    worksheet.addRow(['ID', 'Fecha', 'Hora', 'Número Ticket', 'Nombre Cliente', 'Monto Venta ($)']);
    worksheet.getRow(4).font = { bold: true };

    salesData.forEach(venta => {
        worksheet.addRow([
            venta.id,
            venta.fecha,
            venta.hora,
            venta.numero_ticket,
            venta.monto_total
        ]);
    });

    const totalVentas = salesData.reduce((sum, venta) => sum + parseFloat(venta.monto_total || 0), 0);
    worksheet.addRow([]);
    worksheet.addRow(['', '', '', '', 'Total de Ventas:', totalVentas.toFixed(2)]);
    const totalRow = worksheet.lastRow;
    totalRow.font = { bold: true };
    totalRow.getCell(5).alignment = { horizontal: 'right' };
    totalRow.getCell(6).numFmt = '$#,##0.00';

    worksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            const columnLength = cell.value ? cell.value.toString().length : 10;
            if (columnLength > maxLength) {
                maxLength = columnLength;
            }
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
    });

    return await workbook.xlsx.writeBuffer();
}


async function executeSalesCut(isAutomatic = false) {
    const currentTime = moment().tz("America/Caracas");
    console.log(`Iniciando corte de ventas (${isAutomatic ? 'automático' : 'manual'}) a las ${currentTime.format('YYYY-MM-DD HH:mm:ss')}`);

    const ventas = await getSalesForCurrentCut(currentTime);
    const totalVentasPeriodo = ventas.reduce((sum, venta) => sum + parseFloat(venta.monto_total || 0), 0);

    const dailySales = await getDailySales(currentTime);
    const totalVentasDiarias = dailySales.reduce((sum, venta) => sum + parseFloat(venta.monto_total || 0), 0);

    const cutReportBuffer = await generateSalesExcel(ventas, 'corte');
    const cutReportFileName = `Corte_Ventas_${currentTime.format('YYYYMMDD_HHmmss')}.xlsx`;

    const dailyReportBuffer = await generateSalesExcel(dailySales, 'diario');
    const dailyReportFileName = `Reporte_Diario_Ventas_${currentTime.format('YYYYMMDD')}.xlsx`;

    const subjectCut = `Corte de Ventas - ${currentTime.format('YYYY-MM-DD HH:mm:ss')}`;
    const textCut = `Adjunto el reporte del corte de ventas realizado a las ${currentTime.format('HH:mm:ss')} del ${currentTime.format('DD/MM/YYYY')}.`;
    const htmlCut = `<p>Adjunto el reporte del corte de ventas realizado a las <b>${currentTime.format('HH:mm:ss')}</b> del <b>${currentTime.format('DD/MM/YYYY')}</b>.</p>
                      <p>Total de ventas en este corte: <b>$${totalVentasPeriodo.toFixed(2)}</b></p>
                      <p>Este reporte incluye las ventas desde el último corte o el inicio del día.</p>
                      <p>Saludos,<br>Tu Sistema de Rifas</p>`;

    const cutEmailSent = await sendEmailWithAttachment(
        ADMIN_EMAIL_FOR_REPORTS,
        subjectCut,
        textCut,
        htmlCut,
        {
            filename: cutReportFileName,
            content: cutReportBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }
    );

    const subjectDaily = `Reporte Diario de Ventas - ${currentTime.format('YYYY-MM-DD')}`;
    const textDaily = `Adjunto el reporte de ventas diarias hasta las ${currentTime.format('HH:mm:ss')} del ${currentTime.format('DD/MM/YYYY')}.`;
    const htmlDaily = `<p>Adjunto el reporte de ventas diarias hasta las <b>${currentTime.format('HH:mm:ss')}</b> del <b>${currentTime.format('DD/MM/YYYY')}</b>.</p>
                       <p>Total de ventas del día hasta ahora: <b>$${totalVentasDiarias.toFixed(2)}</b></p>
                       <p>Saludos,<br>Tu Sistema de Rifas</p>`;

    const dailyEmailSent = await sendEmailWithAttachment(
        ADMIN_EMAIL_FOR_REPORTS,
        subjectDaily,
        textDaily,
        htmlDaily,
        {
            filename: dailyReportFileName,
            content: dailyReportBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }
    );

    const config = await readJsonFile(CONFIG_FILE);
    config.last_sales_cut_timestamp = currentTime.toISOString();
    await writeJsonFile(CONFIG_FILE, config);

    console.log(`✔ Corte de ventas completado. Correos de corte enviados: ${cutEmailSent}. Correos diarios enviados: ${dailyEmailSent}.`);
}


app.post('/api/admin/execute-sales-cut', async (req, res) => {
    try {
        const { auto } = req.body;
        await executeSalesCut(auto);
        res.json({ message: 'Corte de ventas ejecutado exitosamente!' });
    } catch (error) {
        console.error('❌ Error al ejecutar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al ejecutar corte de ventas.', error: error.message });
    }
});


app.get('/api/admin/export-sales-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        const buffer = await generateSalesExcel(ventas, 'todas');

        res.setHeader('Content-Disposition', 'attachment; filename="Todas_Ventas_Sistema_Rifas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas a Excel.', error: error.message });
    }
});


app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use((req, res, next) => {
    res.status(404).json({ message: 'Ruta no encontrada.', path: req.path, method: req.method });
});

app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack);
    res.status(500).json({ message: 'Ocurrió un error inesperado en el servidor.', error: err.message });
});

app.listen(port, async () => {
    console.log(`Servidor de backend escuchando en http://localhost:${port}`);
    await initializeEmailConfig();
});

cron.schedule('0 0 * * *', async () => {
    console.log('✨ Ejecutando tarea programada: Corte de ventas automático.');
    try {
        await executeSalesCut(true);
        console.log('✅ Corte de ventas automático completado.');
    } catch (error) {
        console.error('❌ Error en el corte de ventas automático:', error);
    }
}, {
    scheduled: true,
    timezone: "America/Caracas"
});