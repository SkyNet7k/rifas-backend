// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone'); // Asegúrate de que esta línea esté presente
const ExcelJS = require('exceljs'); // Para exportar a Excel

dotenv.config(); // Carga las variables de entorno desde .env si estás en desarrollo

const app = express();
const port = process.env.PORT || 3000;

// Definición de API_BASE_URL para los correos (puedes configurarlo como variable de entorno en Render)
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// --- Configuración de CORS ---
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app', // Tu panel de cliente
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

// --- Rutas y lógica para archivos JSON (configuración, horarios, ventas) ---
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');

// Función auxiliar para leer JSON
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado en ${filePath}. Creando archivo vacío.`);
            return {}; // Retorna un objeto vacío si el archivo no existe
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw error;
    }
}

// Función auxiliar para escribir JSON
async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir en el archivo ${filePath}:`, error);
        throw error;
    }
}

// --- Configuración de Nodemailer (Transporter) ---
// IMPORTANT: Esto se lee de process.env. ¡Asegúrate de que tus variables de entorno en Render estén configuradas!
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10), // Asegúrate de que el puerto sea un número
    secure: process.env.EMAIL_SECURE === 'true', // true para puerto 465 (SSL), false para otros (como 587 con TLS)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Correo del administrador para los reportes (también desde variables de entorno)
const ADMIN_EMAIL_FOR_REPORTS = process.env.ADMIN_EMAIL_FOR_REPORTS;


// Función para enviar correo electrónico con adjunto
async function sendEmailWithAttachment(to, subject, text, html, attachment) {
    try {
        const mailOptions = {
            from: {
                name: process.env.EMAIL_SENDER_NAME || 'Sistema de Rifas', // Puedes añadir esta variable de entorno también
                address: process.env.EMAIL_USER // El remitente es tu propio correo
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

// --- Rutas de API para Configuración General ---

// Obtener configuración general
app.get('/api/configuracion', async (req, res) => {
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
        // Asegúrate de solo actualizar campos permitidos
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
            // ¡NO ACTUALICES mail_config o admin_email_for_reports desde aquí!
        };
        await writeJsonFile(CONFIG_FILE, updatedConfig);
        res.json({ message: 'Configuración actualizada exitosamente', config: updatedConfig });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});

// --- Rutas de API para Horarios Zulia ---

// Obtener horarios de Zulia
app.get('/api/horarios-zulia', async (req, res) => {
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
        const nuevaVenta = req.body;
        const ventas = await readJsonFile(VENTAS_FILE);
        if (!Array.isArray(ventas)) {
            ventas = []; // Inicializar como array si no lo es
        }

        // Leer la configuración actual para el último número de ticket
        const config = await readJsonFile(CONFIG_FILE);
        let ultimoNumeroTicket = config.ultimo_numero_ticket || 0;

        // Asignar y actualizar el número de ticket correlativo
        ultima_fecha_resultados_zulia = moment().tz("America/Caracas").format('YYYY-MM-DD');

        // Asignar el ID y la fecha/hora
        nuevaVenta.id = Date.now().toString(); // ID único basado en timestamp
        nuevaVenta.fecha = moment().tz("America/Caracas").format('YYYY-MM-DD');
        nuevaVenta.hora = moment().tz("America/Caracas").format('HH:mm:ss');
        nuevaVenta.numero_ticket = ++ultimoNumeroTicket; // Incrementar y asignar el nuevo número de ticket

        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);

        // Actualizar el último número de ticket en la configuración
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

// Función para obtener las ventas de hoy (desde la hora del corte anterior si aplica)
async function getSalesForCurrentCut(currentTime = moment().tz("America/Caracas")) {
    const ventas = await readJsonFile(VENTAS_FILE);
    const config = await readJsonFile(CONFIG_FILE);

    // Determinar la hora del último corte para filtrar las ventas
    const lastCutTime = config.last_sales_cut_timestamp ?
        moment(config.last_sales_cut_timestamp).tz("America/Caracas") :
        moment(currentTime).startOf('day'); // Si no hay corte previo, desde el inicio del día

    return ventas.filter(venta => {
        const ventaDateTime = moment(`${venta.fecha} ${venta.hora}`).tz("America/Caracas");
        return ventaDateTime.isSameOrAfter(lastCutTime) && ventaDateTime.isSameOrBefore(currentTime);
    });
}

// Función para obtener las ventas de todo el día para el reporte
async function getDailySales(date = moment().tz("America/Caracas")) {
    const ventas = await readJsonFile(VENTAS_FILE);
    const formattedDate = date.format('YYYY-MM-DD');
    return ventas.filter(venta => venta.fecha === formattedDate);
}

// Función para generar el reporte de ventas en Excel
async function generateSalesExcel(salesData, cutType = 'corte') {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte de Ventas');

    // Título y fecha
    worksheet.mergeCells('A1:F1');
    worksheet.getCell('A1').value = `Reporte de Ventas - ${cutType === 'corte' ? 'Corte' : 'Diario'}`;
    worksheet.getCell('A1').font = { bold: true, size: 16 };
    worksheet.getCell('A1').alignment = { horizontal: 'center' };

    worksheet.mergeCells('A2:F2');
    worksheet.getCell('A2').value = `Fecha: ${moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss')}`;
    worksheet.getCell('A2').alignment = { horizontal: 'center' };
    worksheet.getCell('A2').font = { italic: true };

    // Encabezados
    worksheet.addRow(['ID', 'Fecha', 'Hora', 'Número Ticket', 'Nombre Cliente', 'Monto Venta ($)']);
    worksheet.getRow(4).font = { bold: true };

    // Datos
    salesData.forEach(venta => {
        worksheet.addRow([
            venta.id,
            venta.fecha,
            venta.hora,
            venta.numero_ticket,
            venta.nombre_cliente,
            venta.monto_total // Asumo que el monto_total ya está en dólares
        ]);
    });

    // Cálculos de totales
    const totalVentas = salesData.reduce((sum, venta) => sum + parseFloat(venta.monto_total || 0), 0);
    worksheet.addRow([]); // Fila en blanco
    worksheet.addRow(['', '', '', '', 'Total de Ventas:', totalVentas.toFixed(2)]);
    const totalRow = worksheet.lastRow;
    totalRow.font = { bold: true };
    totalRow.getCell(5).alignment = { horizontal: 'right' }; // Alinea el texto "Total de Ventas:"
    totalRow.getCell(6).numFmt = '$#,##0.00'; // Formato de moneda para el total

    // Ajustar anchos de columna
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

    // Buffer para el archivo
    return await workbook.xlsx.writeBuffer();
}


// Función principal para ejecutar el corte de ventas
async function executeSalesCut(isAutomatic = false) {
    const currentTime = moment().tz("America/Caracas");
    console.log(`Iniciando corte de ventas (${isAutomatic ? 'automático' : 'manual'}) a las ${currentTime.format('YYYY-MM-DD HH:mm:ss')}`);

    const ventas = await getSalesForCurrentCut(currentTime); // Obtener ventas desde el último corte
    const totalVentasPeriodo = ventas.reduce((sum, venta) => sum + parseFloat(venta.monto_total || 0), 0);

    const dailySales = await getDailySales(currentTime); // Obtener ventas de todo el día para el reporte diario
    const totalVentasDiarias = dailySales.reduce((sum, venta) => sum + parseFloat(venta.monto_total || 0), 0);

    // Generar reporte de corte (con las ventas desde el último corte)
    const cutReportBuffer = await generateSalesExcel(ventas, 'corte');
    const cutReportFileName = `Corte_Ventas_${currentTime.format('YYYYMMDD_HHmmss')}.xlsx`;

    // Generar reporte diario (con las ventas de todo el día)
    const dailyReportBuffer = await generateSalesExcel(dailySales, 'diario');
    const dailyReportFileName = `Reporte_Diario_Ventas_${currentTime.format('YYYYMMDD')}.xlsx`;

    // 1. Enviar correo con el reporte del corte actual
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

    // 2. Enviar correo con el reporte diario (si no es el mismo que el de corte)
    // Se asume que el reporte diario se envía al final del día o en un corte que abarque el día entero.
    // Aquí lo enviamos siempre, pero si el corte es a media mañana, este diario incluirá ventas hasta ese momento.
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

    // Actualizar el timestamp del último corte de ventas en la configuración
    const config = await readJsonFile(CONFIG_FILE);
    config.last_sales_cut_timestamp = currentTime.toISOString(); // Guarda como ISO string para fácil parseo
    await writeJsonFile(CONFIG_FILE, config);

    console.log(`✔ Corte de ventas completado. Correos de corte enviados: ${cutEmailSent}. Correos diarios enviados: ${dailyEmailSent}.`);
}


// Ruta para ejecutar el corte de ventas (solo admin)
app.post('/api/admin/execute-sales-cut', async (req, res) => {
    try {
        const { auto } = req.body; // Puedes pasar 'true' para indicar que es un corte automático (aunque aquí sea manual)
        await executeSalesCut(auto);
        res.json({ message: 'Corte de ventas ejecutado exitosamente!' });
    } catch (error) {
        console.error('❌ Error al ejecutar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al ejecutar corte de ventas.', error: error.message });
    }
});


// Ruta para exportar las ventas a Excel (ADMIN)
app.get('/api/admin/export-sales-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        const buffer = await generateSalesExcel(ventas, 'todas'); // Puedes usar 'todas' para un reporte completo

        res.setHeader('Content-Disposition', 'attachment; filename="Todas_Ventas_Sistema_Rifas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas a Excel.', error: error.message });
    }
});


// Middleware para servir archivos estáticos (¡Importante para los comprobantes!)
// Asegúrate de que la carpeta 'uploads' exista en tu proyecto.
// Render automáticamente la crea si la subes con tu código.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware para manejar rutas no encontradas (404)
// Este middleware DEBE ir después de todas tus rutas definidas
app.use((req, res, next) => {
    res.status(404).json({ message: 'Ruta no encontrada.', path: req.path, method: req.method });
});

// Manejador de errores general
// Este middleware DEBE ir al final de todos los middlewares y rutas
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack);
    res.status(500).json({ message: 'Ocurrió un error inesperado en el servidor.', error: err.message });
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor de backend escuchando en http://localhost:${port}`);
    console.log('Variables de entorno cargadas para correo:');
    console.log('EMAIL_HOST:', process.env.EMAIL_HOST ? '*****' : 'NO CONFIGURADO');
    console.log('EMAIL_PORT:', process.env.EMAIL_PORT ? '*****' : 'NO CONFIGURADO');
    console.log('EMAIL_USER:', process.env.EMAIL_USER ? process.env.EMAIL_USER : 'NO CONFIGURADO');
    console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? '*****' : 'NO CONFIGURADO');
    console.log('EMAIL_SECURE:', process.env.EMAIL_SECURE);
    console.log('ADMIN_EMAIL_FOR_REPORTS:', process.env.ADMIN_EMAIL_FOR_REPORTS ? process.env.ADMIN_EMAIL_FOR_REPORTS : 'NO CONFIGURADO');
});

// --- Tareas Programadas (Cron Jobs) ---
// Tarea CRON para ejecutar el corte de ventas automáticamente (Ej: cada 24 horas a medianoche)
// Adapta el cron a tus necesidades. Ejemplo: '0 0 * * *' para medianoche diaria.
// NOTA: Para un corte de ventas específico para cada sorteo, necesitarías otra lógica.
// Esto es un ejemplo de corte diario.
cron.schedule('0 0 * * *', async () => {
    console.log('✨ Ejecutando tarea programada: Corte de ventas automático.');
    try {
        await executeSalesCut(true); // Pasar 'true' para indicar que es automático
        console.log('✅ Corte de ventas automático completado.');
    } catch (error) {
        console.error('❌ Error en el corte de ventas automático:', error);
    }
}, {
    scheduled: true,
    timezone: "America/Caracas" // Asegúrate de que la zona horaria sea correcta para tu lógica de negocio
});

// --- Funciones adicionales (si es que las tenías o se necesitan) ---

// Función para obtener el último número de ticket y actualizarlo
// (Ya integrada en app.post('/api/ventas'))

// Función para obtener la última fecha de resultados de Zulia
// (Ya integrada en app.put('/api/admin/configuracion'))

// Función para cargar horarios de Zulia
// (Ya integrada en app.get('/api/horarios-zulia') y app.put('/api/admin/horarios-zulia'))

// Función para generar nombres de archivo de comprobantes (si es que los usas)
// function generateComprobanteFileName(ticketId) {
//     return `comprobante_${ticketId}.pdf`; // O .png, .jpg, etc.
// }