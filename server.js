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
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const COMPROBANTES_DIR = path.join(__dirname, 'uploads');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');

// --- Funciones de Utilidad para lectura/escritura de archivos JSON ---
async function readJsonFile(filePath, defaultValue = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        console.error(`Error reading file ${filePath}:`, error);
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error writing file ${filePath}:`, error);
        throw error;
    }
}

async function ensureComprobantesDir() {
    try {
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating comprobantes directory:', error);
    }
}

// --- Configuración de Nodemailer ---
let transporter = null;

async function setupMailer() {
    const config = await readJsonFile(CONFIG_FILE);
    const mailConfig = config.mail_config;

    if (mailConfig && mailConfig.host && mailConfig.user && mailConfig.pass) {
        transporter = nodemailer.createTransport({
            host: mailConfig.host,
            port: mailConfig.port || 587,
            secure: mailConfig.secure || false, // true for 465, false for other ports
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass,
            },
            tls: {
                // do not fail on invalid certs
                rejectUnauthorized: false
            }
        });
        console.log('Nodemailer transporter configurado.');
    } else {
        console.warn('Configuración de correo incompleta en configuracion.json. Los correos no se podrán enviar.');
        transporter = null;
    }
}

// Llamar a setupMailer al inicio para configurar el transporter
setupMailer();

// Función para enviar correos electrónicos
async function sendEmail(to, subject, html, attachments = []) {
    if (!transporter) {
        console.error('Transporter de correo no configurado. No se puede enviar el correo.');
        return false;
    }
    const config = await readJsonFile(CONFIG_FILE);
    const senderName = config.mail_config?.senderName || 'Sistema';

    const mailOptions = {
        from: `"${senderName}" <${config.mail_config.user}>`,
        to: to,
        subject: subject,
        html: html,
        attachments: attachments,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Correo enviado a ${to}`);
        return true;
    } catch (error) {
        console.error(`Error al enviar correo a ${to}:`, error);
        return false;
    }
}

// --- Rutas de la API ---

// Ruta para obtener configuración (tasa, página bloqueada, fecha sorteo, etc.)
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar la configuración.', error: error.message });
    }
});

// Ruta para actualizar configuración (solo acceso administrativo)
app.post('/api/configuracion', async (req, res) => {
    try {
        let config = await readJsonFile(CONFIG_FILE);
        const updatedConfig = { ...config, ...req.body };

        // Validar si la nueva tasa_dolar es un número
        if (updatedConfig.tasa_dolar && typeof updatedConfig.tasa_dolar !== 'number') {
            // Intenta convertir a número si viene como string
            const parsedTasa = parseFloat(updatedConfig.tasa_dolar);
            if (isNaN(parsedTasa)) {
                return res.status(400).json({ message: 'La tasa_dolar debe ser un valor numérico válido.' });
            }
            updatedConfig.tasa_dolar = parsedTasa;
        }

        await writeJsonFile(CONFIG_FILE, updatedConfig);
        // Volver a configurar el mailer si la configuración de correo ha cambiado
        await setupMailer();
        res.json({ message: 'Configuración actualizada con éxito.', config: updatedConfig });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar la configuración.', error: error.message });
    }
});

// Ruta para obtener todos los números (para el panel de administración)
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE, []);
        res.json(numeros);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar los números.', error: error.message });
    }
});

// Ruta para obtener los números disponibles (para el usuario final)
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE, []);
        const disponibles = numeros.filter(n => !n.comprado);
        res.json(disponibles);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar los números disponibles.', error: error.message });
    }
});

// Ruta para registrar una venta
app.post('/api/venta', async (req, res) => {
    const { nombre_apellido, telefono, cedula, email, numeros_comprados, valor_usd, valor_bs, metodo_pago, referencia_pago, tipo_documento } = req.body;
    const comprobanteFile = req.files ? req.files.comprobante : null;

    if (!nombre_apellido || !telefono || !numeros_comprados || numeros_comprados.length === 0 || !valor_usd || !valor_bs || !metodo_pago) {
        return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }

    try {
        let ventas = await readJsonFile(VENTAS_FILE, []);
        let numeros = await readJsonFile(NUMEROS_FILE, []);
        let config = await readJsonFile(CONFIG_FILE);

        const now = moment().tz("America/Caracas");
        const fechaHoraCompra = now.format('YYYY-MM-DD HH:mm:ss');
        const fechaCompra = now.format('YYYY-MM-DD');

        // Validar y marcar números como comprados
        const numerosNoDisponibles = numeros_comprados.filter(num => {
            const index = numeros.findIndex(n => n.numero === num && !n.comprado);
            if (index === -1) {
                return true; // El número no está disponible o ya fue comprado
            }
            numeros[index].comprado = true; // Marcar como comprado
            numeros[index].fecha_compra = fechaHoraCompra; // Registrar fecha de compra
            return false;
        });

        if (numerosNoDisponibles.length > 0) {
            return res.status(400).json({ message: `Algunos números no están disponibles: ${numerosNoDisponibles.join(', ')}.`, unavailableNumbers: numerosNoDisponibles });
        }

        // Generar un ID único para la venta y el ticket
        const ultimoTicket = config.ultimo_numero_ticket || 0;
        const nuevoTicketId = ultimoTicket + 1;
        config.ultimo_numero_ticket = nuevoTicketId;

        let comprobantePath = null;
        let comprobanteFilename = null;
        let comprobanteMimeType = null;

        if (comprobanteFile) {
            comprobanteFilename = `${Date.now()}-${comprobanteFile.name}`;
            comprobantePath = path.join(COMPROBANTES_DIR, comprobanteFilename);
            await comprobanteFile.mv(comprobantePath);
            comprobanteMimeType = comprobanteFile.mimetype;
        }

        const nuevaVenta = {
            id: nuevoTicketId, // Usamos el número de ticket como ID de venta
            nombre_apellido,
            telefono,
            cedula,
            email,
            numeros_comprados,
            valor_usd: parseFloat(valor_usd),
            valor_bs: parseFloat(valor_bs),
            metodo_pago,
            referencia_pago: referencia_pago || 'N/A',
            tipo_documento: tipo_documento || 'V', // Por defecto V
            comprobante_nombre: comprobanteFilename,
            comprobante_tipo: comprobanteMimeType,
            fecha_hora_compra: fechaHoraCompra,
            fecha_compra: fechaCompra, // Para filtro más fácil
            correlativo_sorteo: config.numero_sorteo_correlativo || 1 // Correlativo del sorteo actual
        };

        ventas.push(nuevaVenta);

        await writeJsonFile(VENTAS_FILE, ventas);
        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(CONFIG_FILE, config);

        // Envío de correo al comprador
        if (email) {
            const emailSubject = `Confirmación de Compra - Rifas y Loterías #${nuevaVenta.id}`;
            let emailHtml = `
                <p>Hola ${nombre_apellido},</p>
                <p>Gracias por tu compra en nuestro sistema de Rifas y Loterías.</p>
                <p>Aquí están los detalles de tu compra:</p>
                <ul>
                    <li><strong>ID de Ticket:</strong> ${nuevaVenta.id}</li>
                    <li><strong>Números comprados:</strong> ${numeros_comprados.join(', ')}</li>
                    <li><strong>Valor Total (USD):</strong> $${valor_usd.toFixed(2)}</li>
                    <li><strong>Valor Total (Bs):</strong> Bs ${valor_bs.toFixed(2)}</li>
                    <li><strong>Método de Pago:</strong> ${metodo_pago}</li>
                    <li><strong>Fecha y Hora:</strong> ${fechaHoraCompra}</li>
                </ul>
                <p>¡Mucha suerte en el próximo sorteo!</p>
                <p>Saludos,</p>
                <p>El equipo de Rifas y Loterías</p>
            `;

            let attachments = [];
            if (comprobantePath) {
                attachments.push({
                    filename: comprobanteFilename,
                    path: comprobantePath,
                    contentType: comprobanteMimeType
                });
            }

            await sendEmail(email, emailSubject, emailHtml, attachments);
        }

        // Envío de notificación por WhatsApp a administradores (si está configurado)
        const adminNumbers = config.admin_whatsapp_numbers || [];
        if (adminNumbers.length > 0) {
            const whatsappMessage = encodeURIComponent(`¡Nueva Venta!\nTicket #${nuevaVenta.id}\nComprador: ${nombre_apellido}\nNúmeros: ${numeros_comprados.join(', ')}\nTotal: $${valor_usd.toFixed(2)} / Bs ${valor_bs.toFixed(2)}\nMétodo: ${metodo_pago}\nFecha: ${fechaHoraCompra}`);

            for (const number of adminNumbers) {
                // Aquí puedes integrar una API de WhatsApp Gateway si la tienes,
                // por ahora solo logueamos el mensaje o generamos un enlace de ejemplo.
                console.log(`Mensaje WhatsApp para ${number}: https://wa.me/${number}?text=${whatsappMessage}`);
            }
        }


        res.status(201).json({ message: 'Venta registrada con éxito.', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar la venta.', error: error.message });
    }
});

// Ruta para obtener una venta por ID
app.get('/api/venta/:id', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        const venta = ventas.find(v => v.id === parseInt(req.params.id));
        if (venta) {
            res.json(venta);
        } else {
            res.status(404).json({ message: 'Venta no encontrada.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la venta.', error: error.message });
    }
});

// Ruta para obtener todas las ventas (para el panel de administración)
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        res.json(ventas);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar las ventas.', error: error.message });
    }
});

// Ruta para obtener ventas por fecha
app.get('/api/ventas-por-fecha', async (req, res) => {
    const { fecha } = req.query; // Formato YYYY-MM-DD
    if (!fecha) {
        return res.status(400).json({ message: 'La fecha es obligatoria.' });
    }

    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        const ventasFiltradas = ventas.filter(venta => venta.fecha_compra === fecha);
        res.json(ventasFiltradas);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener ventas por fecha.', error: error.message });
    }
});

// Ruta para cargar/subir imagen de comprobante (no es una API REST tradicional, solo para servir el archivo)
app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(COMPROBANTES_DIR, filename);
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error al enviar el archivo de comprobante:', err);
            res.status(404).json({ message: 'Archivo no encontrado.' });
        }
    });
});

// Ruta para obtener horarios de Zulia
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia: [] });
        res.json(horarios);
    } catch (error) {
        console.error('Error al cargar horarios de Zulia:', error);
        res.status(500).json({ message: 'Error al cargar horarios de Zulia.', error: error.message });
    }
});

// Ruta para guardar/actualizar resultados de Zulia
app.post('/api/resultados-zulia', async (req, res) => {
    const { fecha, resultados, horario_correspondiente } = req.body;
    if (!fecha || !resultados || !horario_correspondiente) {
        return res.status(400).json({ message: 'Fecha, resultados y horario_correspondiente son obligatorios.' });
    }

    try {
        let resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        let config = await readJsonFile(CONFIG_FILE);

        const now = moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss');

        const nuevoResultado = {
            id: resultadosZulia.length + 1, // Simple ID incremental
            fecha: fecha,
            horario: horario_correspondiente,
            resultados: resultados, // Esto debería ser un array de números [XX, YY, ZZ]
            fecha_registro: now
        };

        resultadosZulia.push(nuevoResultado);
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);

        // Actualizar la última fecha de resultados en la configuración
        config.ultima_fecha_resultados_zulia = fecha;
        await writeJsonFile(CONFIG_FILE, config);

        res.status(201).json({ message: 'Resultados de Zulia guardados con éxito.', resultado: nuevoResultado });

    } catch (error) {
        console.error('Error al guardar resultados de Zulia:', error);
        res.status(500).json({ message: 'Error al guardar resultados de Zulia.', error: error.message });
    }
});

// Ruta para obtener resultados de Zulia por fecha
app.get('/api/resultados-zulia-por-fecha', async (req, res) => {
    const { fecha } = req.query;
    if (!fecha) {
        return res.status(400).json({ message: 'La fecha es obligatoria.' });
    }

    try {
        const resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        const resultadosFiltrados = resultadosZulia.filter(r => r.fecha === fecha);
        res.json(resultadosFiltrados);
    } catch (error) {
        console.error('Error al obtener resultados de Zulia por fecha:', error);
        res.status(500).json({ message: 'Error al obtener resultados de Zulia por fecha.', error: error.message });
    }
});


// --- Tareas Programadas con node-cron ---

// Tarea programada para generar reporte de ventas, enviar correo, reiniciar números y actualizar fecha sorteo
// Originalmente: '0 0 * * *' (medianoche)
// CAMBIADO A: '*/55 * * * *' (cada 55 minutos)
cron.schedule('*/55 * * * *', async () => {
    const now = moment().tz("America/Caracas");
    const yesterday = now.clone().subtract(1, 'days').format('YYYY-MM-DD'); // Obtener fecha de ayer para el reporte

    console.log(`Ejecutando tarea programada de corte de ventas y reinicio para el día: ${yesterday} a las ${now.format('HH:mm')}`);

    try {
        const config = await readJsonFile(CONFIG_FILE);
        const ventas = await readJsonFile(VENTAS_FILE, []);

        // Filtrar ventas del día anterior
        const ventasDelDiaAnterior = ventas.filter(venta =>
            moment(venta.fecha_compra).tz("America/Caracas").format('YYYY-MM-DD') === yesterday
        );

        // Crear libro de Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Ventas');

        // Columnas
        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 10 },
            { header: 'Fecha y Hora', key: 'fecha_hora_compra', width: 20 },
            { header: 'Comprador', key: 'nombre_apellido', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Números Comprados', key: 'numeros_comprados', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia', key: 'referencia_pago', width: 20 },
        ];

        // Añadir filas
        ventasDelDiaAnterior.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: venta.fecha_hora_compra,
                nombre_apellido: venta.nombre_apellido,
                telefono: venta.telefono,
                cedula: venta.cedula,
                email: venta.email,
                numeros_comprados: venta.numeros_comprados.join(', '),
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
            });
        });

        // Sumar totales
        const totalUsd = ventasDelDiaAnterior.reduce((sum, venta) => sum + venta.valor_usd, 0);
        const totalBs = ventasDelDiaAnterior.reduce((sum, venta) => sum + venta.valor_bs, 0);

        worksheet.addRow({}); // Fila en blanco
        worksheet.addRow({
            nombre_apellido: 'TOTALES:',
            valor_usd: totalUsd.toFixed(2),
            valor_bs: totalBs.toFixed(2),
        });

        // Generar buffer del Excel
        const buffer = await workbook.xlsx.writeBuffer();

        // Enviar correo con el reporte adjunto si hay un correo de administrador configurado
        const adminEmail = config.admin_email_for_reports;
        if (adminEmail) {
            await sendEmail(
                adminEmail,
                `Reporte de Ventas Diario - ${yesterday}`,
                `<p>Adjunto encontrarás el reporte de ventas correspondiente al día ${yesterday}.</p><p>Total USD: $${totalUsd.toFixed(2)}</p><p>Total Bs: Bs ${totalBs.toFixed(2)}</p>`,
                [{ filename: `Corte_Ventas_${yesterday}.xlsx`, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
            );
            console.log(`Correo de corte de ventas automático enviado a ${adminEmail}`);
        } else {
            console.warn('No se ha configurado un correo de administrador para reportes en la configuración.');
        }

        // Reiniciar números disponibles para el próximo sorteo (para el próximo día de sorteo)
        // Solo reiniciar si la fecha del sorteo actual es el día de ayer (ya pasó)
        const currentDrawDate = moment(config.fecha_sorteo).tz("America/Caracas").format('YYYY-MM-DD');

        if (currentDrawDate === yesterday) { // Si la fecha del sorteo actual es AYER, significa que ese sorteo ya pasó y hay que reiniciar para el de HOY
            const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
                numero: i.toString().padStart(2, '0'),
                comprado: false
            }));
            await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
            console.log('Números disponibles reiniciados automáticamente para el nuevo sorteo.');

            // Actualizar la fecha del próximo sorteo a hoy y el correlativo
            config.fecha_sorteo = now.format('YYYY-MM-DD'); // La fecha del sorteo es HOY
            config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) no es el día del reporte (${yesterday}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas"
});


// Inicialización del servidor
ensureComprobantesDir().then(() => {
    app.listen(port, () => {
        console.log(`Servidor de la API escuchando en ${API_BASE_URL}`);
        console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
        console.log(`Sitio de usuario disponible en: https://tuoportunidadeshoy.netlify.app`);
    });
});