// server.js

const express = require('express');
// const fileUpload = require('express-fileupload'); // <-- ELIMINAR/COMENTAR: Ya no se usa para subir archivos
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone'); // Asegúrate de que moment-timezone esté instalado
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
app.use(express.json()); // Necesario para parsear el body JSON
app.use(express.urlencoded({ extended: true }));
// app.use(fileUpload()); // <-- ELIMINAR/COMENTAR: Ya no se usa para subir archivos

const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
// const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes'); // Ya no es estrictamente necesario si no se suben archivos

// --- Funciones auxiliares para leer y escribir JSON ---
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

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Asegurar que el directorio de comprobantes exista (Opcional, si lo necesitas para otra cosa)
// async function ensureComprobantesDir() {
//     try {
//         await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
//     } catch (error) {
//         console.error('Error al crear el directorio de comprobantes:', error);
//     }
// }

// --- Configuración de Nodemailer (para envío de correos) ---
let transporter;
async function initializeMailer() {
    const config = await readJsonFile(CONFIG_FILE);
    if (config.mail_config && config.mail_config.host && config.mail_config.user && config.mail_config.pass) {
        transporter = nodemailer.createTransport({
            host: config.mail_config.host,
            port: config.mail_config.port,
            secure: config.mail_config.secure,
            auth: {
                user: config.mail_config.user,
                pass: config.mail_config.pass,
            },
        });
        console.log('Transporter de correo inicializado.');
    } else {
        console.warn('Configuración de correo incompleta en configuracion.json.');
    }
}

async function sendMail(to, subject, html, attachments = []) {
    if (!transporter) {
        console.error('Transporter de correo no inicializado. No se puede enviar correo.');
        return;
    }
    const config = await readJsonFile(CONFIG_FILE);
    const mailOptions = {
        from: `"${config.mail_config.senderName || 'Sistema de Rifas'}" <${config.mail_config.user}>`,
        to: to,
        subject: subject,
        html: html,
        attachments: attachments,
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`Correo enviado a ${to}`);
    } catch (error) {
        console.error(`Error al enviar correo a ${to}:`, error);
    }
}

// --- RUTAS DE LA API ---

// Ruta para obtener la configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        // No enviar información sensible como la contraseña de correo al frontend
        const { mail_config, ...safeConfig } = config;
        res.json(safeConfig);
    } catch (error) {
        console.error('Error al obtener la configuración:', error);
        res.status(500).json({ message: 'Error al obtener la configuración' });
    }
});

// Ruta para actualizar la configuración (Solo para panel de administración)
app.put('/api/configuracion', async (req, res) => {
    try {
        let config = await readJsonFile(CONFIG_FILE);
        const {
            tasa_dolar,
            pagina_bloqueada,
            fecha_sorteo,
            precio_ticket,
            numero_sorteo_correlativo,
            mail_host,
            mail_port,
            mail_secure,
            mail_user,
            mail_pass,
            mail_sender_name,
            admin_whatsapp_numbers,
            admin_email_for_reports,
        } = req.body;

        if (tasa_dolar !== undefined) config.tasa_dolar = parseFloat(tasa_dolar);
        if (pagina_bloqueada !== undefined) config.pagina_bloqueada = Boolean(pagina_bloqueada);
        if (fecha_sorteo) config.fecha_sorteo = fecha_sorteo;
        if (precio_ticket !== undefined) config.precio_ticket = parseFloat(precio_ticket);
        if (numero_sorteo_correlativo !== undefined) config.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo);
        if (admin_whatsapp_numbers !== undefined) config.admin_whatsapp_numbers = admin_whatsapp_numbers;
        if (admin_email_for_reports !== undefined) config.admin_email_for_reports = admin_email_for_reports;

        // Actualizar configuración de correo
        config.mail_config = config.mail_config || {};
        if (mail_host !== undefined) config.mail_config.host = mail_host;
        if (mail_port !== undefined) config.mail_config.port = parseInt(mail_port);
        if (mail_secure !== undefined) config.mail_config.secure = Boolean(mail_secure);
        if (mail_user !== undefined) config.mail_config.user = mail_user;
        if (mail_pass !== undefined) config.mail_config.pass = mail_pass;
        if (mail_sender_name !== undefined) config.mail_config.senderName = mail_sender_name;


        await writeJsonFile(CONFIG_FILE, config);
        await initializeMailer(); // Re-inicializar el transporter si la configuración de correo cambia
        res.status(200).json({ message: 'Configuración actualizada con éxito.', config: config });
    } catch (error) {
        console.error('Error al actualizar la configuración:', error);
        res.status(500).json({ message: 'Error al actualizar la configuración', error: error.message });
    }
});

// Ruta para obtener números (disponibles y comprados)
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE, Array.from({ length: 1000 }, (_, i) => ({
            numero: i.toString().padStart(3, '0'),
            comprado: false
        })));
        res.json(numeros);
    } catch (error) {
        console.error('Error al obtener números:', error);
        res.status(500).json({ message: 'Error al obtener números' });
    }
});

// Ruta para el proceso de compra
app.post('/api/comprar', async (req, res) => {
    try {
        // console.log('req.body:', req.body); // Log para depuración

        // Desestructurar los datos del body (JSON)
        const {
            nombreApellido,
            telefono,
            metodoPago,
            referenciaPago,
            numerosComprados, // Esto ya debe ser un array de strings (los números, ej: ["001", "005"])
            totalUsd,
            totalBs,
        } = req.body;

        // Validaciones básicas
        if (!nombreApellido || !telefono || !metodoPago || !referenciaPago || !numerosComprados || numerosComprados.length === 0 || totalUsd === undefined || totalBs === undefined) {
            return res.status(400).json({ message: 'Faltan campos obligatorios para la compra.' });
        }
        if (!Array.isArray(numerosComprados)) {
            return res.status(400).json({ message: 'El formato de números comprados no es válido.' });
        }

        let numeros = await readJsonFile(NUMEROS_FILE);
        let ventas = await readJsonFile(VENTAS_FILE, []);
        let config = await readJsonFile(CONFIG_FILE);

        // Generar nuevo ID de venta y número de ticket
        const ventaId = ventas.length > 0 ? Math.max(...ventas.map(v => v.id)) + 1 : 1;
        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        const nuevoNumeroTicket = config.ultimo_numero_ticket;

        const numerosNoDisponibles = [];
        numerosComprados.forEach(num => {
            const numeroIndex = numeros.findIndex(n => n.numero === num);
            if (numeroIndex === -1 || numeros[numeroIndex].comprado) {
                numerosNoDisponibles.push(num);
            }
        });

        if (numerosNoDisponibles.length > 0) {
            return res.status(400).json({
                message: `Los siguientes números ya no están disponibles: ${numerosNoDisponibles.join(', ')}`,
                numerosNoDisponibles: numerosNoDisponibles
            });
        }

        // Marcar números como comprados
        numerosComprados.forEach(num => {
            const numeroIndex = numeros.findIndex(n => n.numero === num);
            if (numeroIndex !== -1) {
                numeros[numeroIndex].comprado = true;
            }
        });

        await writeJsonFile(NUMEROS_FILE, numeros);

        // Crear el objeto de la nueva venta
        const nuevaVenta = {
            id: ventaId,
            fecha_compra: moment().tz('America/Caracas').format('YYYY-MM-DD HH:mm:ss'),
            fecha_sorteo: config.fecha_sorteo,
            numero_ticket: nuevoNumeroTicket,
            comprador: nombreApellido,
            telefono: telefono,
            numeros: numerosComprados,
            valor_usd: parseFloat(totalUsd),
            valor_bs: parseFloat(totalBs),
            metodo_pago: metodoPago,
            referencia_pago: referenciaPago,
            // Eliminados: cedula, email, comprobante_nombre, comprobante_tipo, comprobante_url
        };

        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);
        await writeJsonFile(CONFIG_FILE, config); // Guardar el último número de ticket

        // --- Notificaciones ---
        // 1. Notificación al administrador por WhatsApp
        const adminNumbers = config.admin_whatsapp_numbers || [];
        const mensajeAdmin = `🚨 *NUEVA COMPRA DE RIFA* 🚨\n\n` +
                             `*Ticket #:* ${nuevoNumeroTicket}\n` +
                             `*Comprador:* ${nombreApellido}\n` +
                             `*Teléfono:* ${telefono}\n` +
                             `*Números:* ${numerosComprados.join(', ')}\n` +
                             `*Total USD:* $${totalUsd}\n` +
                             `*Total Bs:* Bs ${totalBs}\n` +
                             `*Método:* ${metodoPago}\n` +
                             `*Referencia:* ${referenciaPago}\n` +
                             `*Fecha Sorteo:* ${moment(config.fecha_sorteo).format('DD/MM/YYYY')}\n\n` +
                             `¡Verifica el pago!`;

        adminNumbers.forEach(adminNum => {
            const whatsappLink = `https://api.whatsapp.com/send?phone=${adminNum}&text=${encodeURIComponent(mensajeAdmin)}`;
            console.log(`WhatsApp Link para Admin (${adminNum}): ${whatsappLink}`); // Esto es para depuración
        });

        // 2. Notificación al cliente por WhatsApp (si se desea)
        // Puedes enviar un mensaje de confirmación al cliente, similar al del frontend.
        const mensajeCliente = `¡Hola ${nombreApellido}!\n\n` +
                               `Gracias por tu compra de rifa.\n\n` +
                               `🎟️ *Comprobante #${nuevoNumeroTicket}*\n` +
                               `🔢 *Tus números:* ${numerosComprados.join(', ')}\n` +
                               `💲 *Total USD:* $${totalUsd}\n` +
                               `💰 *Total Bs:* Bs ${totalBs}\n` +
                               `🗓️ *Fecha Sorteo:* ${moment(config.fecha_sorteo).format('DD/MM/YYYY')}\n\n` +
                               `¡Mucha suerte! 🎉`;
        const whatsappLinkCliente = `https://api.whatsapp.com/send?phone=${telefono.replace('+', '')}&text=${encodeURIComponent(mensajeCliente)}`;
        console.log(`WhatsApp Link para Cliente (${telefono}): ${whatsappLinkCliente}`); // Cliente lo abrirá desde su frontend

        // 3. Envío de correo electrónico al administrador (si configurado y es para reportes)
        const adminEmailForReports = config.admin_email_for_reports;
        if (adminEmailForReports) {
            const emailHtml = `
                <p>Se ha realizado una nueva compra en el sistema de rifas.</p>
                <ul>
                    <li><strong>Comprador:</strong> ${nombreApellido}</li>
                    <li><strong>Teléfono:</strong> ${telefono}</li>
                    <li><strong>Números Comprados:</strong> ${numerosComprados.join(', ')}</li>
                    <li><strong>Total USD:</strong> $${totalUsd}</li>
                    <li><strong>Total Bs:</strong> Bs ${totalBs}</li>
                    <li><strong>Método de Pago:</strong> ${metodoPago}</li>
                    <li><strong>Referencia:</strong> ${referenciaPago}</li>
                    <li><strong>Número de Ticket:</strong> ${nuevoNumeroTicket}</li>
                    <li><strong>Fecha de Compra:</strong> ${nuevaVenta.fecha_compra}</li>
                    <li><strong>Fecha de Sorteo:</strong> ${nuevaVenta.fecha_sorteo}</li>
                </ul>
                <p>Por favor, verifica el pago.</p>
            `;
            await sendMail(adminEmailForReports, `Nueva Compra - Ticket #${nuevoNumeroTicket}`, emailHtml);
        }

        res.status(200).json({
            message: 'Compra realizada con éxito y números reservados.',
            ventaId: ventaId,
            nuevoTicket: nuevoNumeroTicket,
            // No se envía URL de comprobante
        });

    } catch (error) {
        console.error('Error al procesar la compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});


// Ruta para obtener horarios de Zulia (Para panel de administración)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia: [] });
        res.json(horarios.horarios_zulia);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia:', error);
        res.status(500).json({ message: 'Error al obtener horarios de Zulia' });
    }
});

// Ruta para actualizar horarios de Zulia (Para panel de administración)
app.put('/api/horarios-zulia', async (req, res) => {
    try {
        const { horarios } = req.body;
        if (!Array.isArray(horarios)) {
            return res.status(400).json({ message: 'Formato de horarios inválido.' });
        }
        await writeJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia: horarios });
        res.status(200).json({ message: 'Horarios de Zulia actualizados con éxito.' });
    } catch (error) {
        console.error('Error al actualizar horarios de Zulia:', error);
        res.status(500).json({ message: 'Error al actualizar horarios de Zulia' });
    }
});

// Ruta para obtener resultados de Zulia (Para panel de administración)
app.get('/api/resultados-zulia', async (req, res) => {
    try {
        const resultados = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        res.json(resultados);
    } catch (error) {
        console.error('Error al obtener resultados de Zulia:', error);
        res.status(500).json({ message: 'Error al obtener resultados de Zulia' });
    }
});

// Ruta para agregar o actualizar resultados de Zulia (Para panel de administración)
app.post('/api/resultados-zulia', async (req, res) => {
    try {
        const { fecha, hora, numero } = req.body;
        if (!fecha || !hora || numero === undefined || numero === null) {
            return res.status(400).json({ message: 'Faltan campos obligatorios para el resultado.' });
        }

        let resultados = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        const formattedDate = moment(fecha).format('YYYY-MM-DD');

        const existingIndex = resultados.findIndex(
            r => moment(r.fecha).format('YYYY-MM-DD') === formattedDate && r.hora === hora
        );

        const nuevoResultado = {
            fecha: formattedDate,
            hora: hora,
            numero: String(numero).padStart(2, '0') // Asegura 2 dígitos
        };

        if (existingIndex > -1) {
            resultados[existingIndex] = nuevoResultado;
        } else {
            resultados.push(nuevoResultado);
        }

        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultados);
        res.status(200).json({ message: 'Resultado de Zulia guardado con éxito.', resultado: nuevoResultado });
    } catch (error) {
        console.error('Error al guardar resultado de Zulia:', error);
        res.status(500).json({ message: 'Error al guardar resultado de Zulia', error: error.message });
    }
});


// Ruta para obtener todas las ventas
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error al obtener ventas' });
    }
});

// Ruta para exportar ventas a Excel
app.get('/api/exportar-ventas-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        const config = await readJsonFile(CONFIG_FILE);
        const worksheetName = `Ventas Sorteo ${config.numero_sorteo_correlativo || 'N/A'}`;

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(worksheetName);

        // Definir columnas con header y key
        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Número Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 18 },
            { header: 'Números Comprados', key: 'numeros', width: 25 },
            { header: 'Valor USD', key: 'valor_usd', width: 12 },
            { header: 'Valor Bs', key: 'valor_bs', width: 12 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 15 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            // Eliminada la columna de Comprobante
        ];

        // Añadir filas con los datos de las ventas
        ventas.forEach(venta => {
            worksheet.addRow({
                fecha_compra: venta.fecha_compra,
                fecha_sorteo: venta.fecha_sorteo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros.join(', '),
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
            });
        });

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            'attachment; filename=' + `Ventas_Sorteo_${config.numero_sorteo_correlativo || 'N_A'}.xlsx`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error al exportar ventas a Excel', error: error.message });
    }
});


// Tarea programada para realizar el corte de ventas y reinicio de números al final del día
cron.schedule('0 23 * * *', async () => { // Se ejecuta a las 11 PM (23:00) todos los días
    try {
        console.log('Iniciando tarea programada de corte de ventas y reinicio de números...');
        const now = moment().tz('America/Caracas');
        const yesterday = now.clone().subtract(1, 'days').format('YYYY-MM-DD'); // Para el nombre del archivo de corte

        let config = await readJsonFile(CONFIG_FILE);
        let ventas = await readJsonFile(VENTAS_FILE, []);

        // Generar y enviar el reporte de ventas del día por correo al administrador
        const adminEmail = config.admin_email_for_reports;
        if (adminEmail && transporter) {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet(`Ventas_Corte_${yesterday}`);

            worksheet.columns = [
                { header: 'Fecha/Hora Compra', key: 'fecha_compra', width: 20 },
                { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
                { header: 'Número Ticket', key: 'numero_ticket', width: 15 },
                { header: 'Comprador', key: 'comprador', width: 25 },
                { header: 'Teléfono', key: 'telefono', width: 18 },
                { header: 'Números Comprados', key: 'numeros', width: 25 },
                { header: 'Valor USD', key: 'valor_usd', width: 12 },
                { header: 'Valor Bs', key: 'valor_bs', width: 12 },
                { header: 'Método de Pago', key: 'metodo_pago', width: 15 },
                { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
                // Eliminada la columna de Comprobante
            ];

            const salesForYesterday = ventas.filter(venta => moment(venta.fecha_compra).tz('America/Caracas').format('YYYY-MM-DD') === yesterday);
            salesForYesterday.forEach(venta => {
                worksheet.addRow({
                    fecha_compra: venta.fecha_compra,
                    fecha_sorteo: venta.fecha_sorteo,
                    numero_ticket: venta.numero_ticket,
                    comprador: venta.comprador,
                    telefono: venta.telefono,
                    numeros: venta.numeros.join(', '),
                    valor_usd: venta.valor_usd,
                    valor_bs: venta.valor_bs,
                    metodo_pago: venta.metodo_pago,
                    referencia_pago: venta.referencia_pago,
                });
            });

            const buffer = await workbook.xlsx.writeBuffer();

            const emailSubject = `Reporte de Ventas - Sorteo ${config.numero_sorteo_correlativo || 'N/A'} - ${yesterday}`;
            const emailHtml = `<p>Adjunto encontrarás el reporte de ventas del día ${yesterday} para el Sorteo ${config.numero_sorteo_correlativo || 'N/A'}.</p>`;

            await sendMail(
                adminEmail,
                emailSubject,
                emailHtml,
                [{ filename: `Corte_Ventas_${yesterday}.xlsx`, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
            );
            console.log(`Correo de corte de ventas automático enviado a ${adminEmail}`);
        } else {
            console.warn('No se ha configurado un correo de administrador para reportes en la configuración.');
        }

        // Reiniciar números disponibles para el próximo sorteo
        const numerosReiniciados = Array.from({ length: 1000 }, (_, i) => ({ // Asumo 1000 números (000-999)
            numero: i.toString().padStart(3, '0'), // Asegura 3 dígitos
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
        console.log('Números disponibles reiniciados automáticamente para el próximo sorteo.');

        // Actualizar la fecha del próximo sorteo a mañana y el correlativo
        const nextDrawDate = now.clone().add(1, 'days').format('YYYY-MM-DD');
        config.fecha_sorteo = nextDrawDate;
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
        await writeJsonFile(CONFIG_FILE, config);
        console.log(`Fecha del próximo sorteo actualizada automáticamente a: ${nextDrawDate}`);


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas:', error);
    }
}, {
    timezone: "America/Caracas" // Asegura que se ejecuta en la zona horaria correcta
});


// --- Inicialización del servidor ---
// Ya no es necesario llamar a ensureComprobantesDir si no manejas subida de archivos
// ensureComprobantesDir().then(() => {
    initializeMailer().then(() => {
        app.listen(port, () => {
            console.log(`Servidor escuchando en http://localhost:${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
        });
    });
// });