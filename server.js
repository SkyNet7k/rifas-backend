const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron'); // Importar node-cron

const app = express();
const port = process.env.PORT || 3000;

// Configura CORS
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app' // Tu panel de cliente
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(fileUpload());

// Servir archivos estáticos (para los comprobantes subidos)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Rutas de Archivos de Datos ---
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const TERMINOS_CONDICIONES_FILE = path.join(__dirname, 'terminos_condiciones.txt');

// Función para leer archivos JSON
async function leerArchivo(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Creando con valor por defecto.`);
            await escribirArchivo(filePath, defaultValue);
            return defaultValue;
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw error;
    }
}

// Función para escribir archivos JSON
async function escribirArchivo(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir el archivo ${filePath}:`, error);
        throw error;
    }
}

// --- Función para generar el enlace de WhatsApp ---
/**
 * Genera un enlace de WhatsApp para el administrador con los detalles de una nueva venta.
 * @param {object} venta - Objeto de la venta.
 * @param {string} adminPhoneNumber - Número de teléfono del administrador con código de país (ej. '584121234567').
 * @returns {string} El enlace wa.me o null si falta el número del administrador.
 */
function generarEnlaceWhatsApp(venta, adminPhoneNumber) {
    if (!adminPhoneNumber) {
        console.warn('Número de teléfono del administrador para WhatsApp no configurado.');
        return null;
    }

    const { numeroTicket, numeros, comprador, telefono, valorTotalUsd, fechaSorteo } = venta;
    const mensaje = encodeURIComponent(
        `¡Nueva Venta Pendiente!%0A` +
        `Ticket #: *${numeroTicket}*%0A` +
        `Comprador: *${comprador}*%0A` +
        `Teléfono: ${telefono}%0A` +
        `Números: ${numeros.join(', ')}%0A` +
        `Monto USD: $${valorTotalUsd.toFixed(2)}%0A` +
        `Sorteo: ${fechaSorteo}%0A%0A` +
        `Por favor, verifica el pago y confirma la venta.`
    );

    return `https://wa.me/${adminPhoneNumber}?text=${mensaje}`;
}

// --- Función para enviar el reporte por correo ---
/**
 * Envía un reporte de ventas por correo electrónico.
 * @param {object} mailConfig - Configuración del correo (host, port, user, pass).
 * @param {string} toEmail - Dirección de correo del destinatario.
 * @param {string} subject - Asunto del correo.
 * @param {string} htmlContent - Contenido HTML del correo.
 * @param {Buffer} [excelBuffer] - Buffer del archivo Excel adjunto.
 * @param {string} [fileName] - Nombre del archivo Excel.
 */
async function enviarReportePorCorreo(mailConfig, toEmail, subject, htmlContent, excelBuffer = null, fileName = 'reporte.xlsx') {
    if (!mailConfig || !mailConfig.host || !mailConfig.port || !mailConfig.user || !mailConfig.pass || !toEmail) {
        console.error('Configuración de correo incompleta o destinatario no especificado. No se puede enviar el correo.');
        return { success: false, message: 'Configuración de correo incompleta.' };
    }

    try {
        const transporter = nodemailer.createTransport({
            host: mailConfig.host,
            port: mailConfig.port,
            secure: mailConfig.secure,
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        const mailOptions = {
            from: `"${mailConfig.senderName || 'Sistema de Ventas'}" <${mailConfig.user}>`,
            to: toEmail,
            subject: subject,
            html: htmlContent,
            attachments: []
        };

        if (excelBuffer && fileName) {
            mailOptions.attachments.push({
                filename: fileName,
                content: excelBuffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
        }

        const info = await transporter.sendMail(mailOptions);
        console.log('Correo enviado: %s', info.messageId);
        return { success: true, message: 'Correo enviado con éxito.' };
    } catch (error) {
        console.error('Error al enviar el correo:', error);
        return { success: false, message: `Error al enviar el correo: ${error.message}` };
    }
}

// --- Función para enviar el corte automático ---
async function enviarCorteAutomatico() {
    console.log(`[Corte Automático] Iniciando envío de corte a las ${new Date().toLocaleString()}`);
    try {
        const config = await leerArchivo(CONFIG_FILE, {});
        const ventas = await leerArchivo(VENTAS_FILE, []);

        // Obtenemos el número de sorteo y fecha actual para el corte
        const fechaCorte = config.fecha_sorteo || new Date().toISOString().split('T')[0];
        const numeroSorteoCorte = config.numero_sorteo_correlativo;

        // Filtrar solo las ventas del sorteo actual que estén pendientes o confirmadas
        const ventasParaCorte = ventas.filter(venta =>
            venta.fechaSorteo === fechaCorte &&
            venta.numeroSorteoCorrelativo === numeroSorteoCorte &&
            ['pendiente', 'confirmado'].includes(venta.estado)
        );

        let totalVentasUSD = 0;
        let totalVentasBS = 0;
        ventasParaCorte.forEach(venta => {
            totalVentasUSD += venta.valorTotalUsd || 0;
            totalVentasBS += venta.valorTotalBs || 0;
        });

        // 1. Envío de notificación por WhatsApp a todos los números configurados
        const adminWhatsappNumbers = config.admin_whatsapp_numbers; // Ahora es un array
        if (Array.isArray(adminWhatsappNumbers) && adminWhatsappNumbers.length > 0) {
            const mensajeWhatsApp = encodeURIComponent(
                `*Corte Automático de Ventas*\n` +
                `Fecha del Sorteo: *${fechaCorte}*\n` +
                `Sorteo #: *${numeroSorteoCorte}*\n` +
                `Ventas Registradas: *${ventasParaCorte.length}*\n` +
                `Total USD: *$${totalVentasUSD.toFixed(2)}*\n` +
                `Total BS: *Bs. ${totalVentasBS.toFixed(2)}*\n` +
                `\nPara más detalles, revisa tu correo.`
            );

            for (const phoneNumber of adminWhatsappNumbers) {
                const whatsappLink = `https://wa.me/${phoneNumber}?text=${mensajeWhatsApp}`;
                console.log(`[Corte Automático] Enlace WhatsApp para ${phoneNumber}: ${whatsappLink}`);
                // En un entorno real, aquí podrías integrar una API de WhatsApp para enviar el mensaje directamente.
                // Por ahora, solo se imprime el enlace en la consola.
            }
        } else {
            console.warn('[Corte Automático] Números de WhatsApp de administrador no configurados para el envío de cortes.');
        }

        // 2. Envío del reporte por correo
        const mailConfig = config.mail_config;
        const adminEmail = config.admin_email_for_reports;
        let emailSentStatus = { success: false, message: 'Correo de reporte no enviado.' };

        if (adminEmail && mailConfig && mailConfig.user && mailConfig.pass) {
            const emailSubject = `Corte de Ventas - Sorteo #${numeroSorteoCorte} - ${fechaCorte}`;
            const emailHtml = `
                <p>Estimado Administrador,</p>
                <p>Este es un reporte de corte automático de ventas para el sorteo:</p>
                <ul>
                    <li><strong>Sorteo #:</strong> ${numeroSorteoCorte}</li>
                    <li><strong>Fecha del Sorteo:</strong> ${fechaCorte}</li>
                    <li><strong>Ventas Registradas:</strong> ${ventasParaCorte.length}</li>
                    <li><strong>Total en USD:</strong> $${totalVentasUSD.toFixed(2)}</li>
                    <li><strong>Total en Bs:</strong> Bs. ${totalVentasBS.toFixed(2)}</li>
                </ul>
                <p>Adjunto encontrará el detalle de las ventas en formato Excel.</p>
                <p>Saludos cordiales,</p>
                <p>Su Sistema de Rifas</p>
            `;

            let excelBuffer = null;
            let excelFileName = `Corte_Ventas_Sorteo_${numeroSorteoCorte}_${fechaCorte}.xlsx`;
            if (ventasParaCorte.length > 0) {
                const workbook = XLSX.utils.book_new();
                const worksheet = XLSX.utils.json_to_sheet(ventasParaCorte);
                XLSX.utils.book_append_sheet(workbook, worksheet, `Ventas Sorteo ${numeroSorteoCorte}`);
                excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            } else {
                console.log(`[Corte Automático] No hay ventas para el sorteo #${numeroSorteoCorte} - No se generará reporte Excel.`);
            }

            emailSentStatus = await enviarReportePorCorreo(mailConfig, adminEmail, emailSubject, emailHtml, excelBuffer, excelFileName);
            console.log(`[Corte Automático] Estado del envío de correo: ${emailSentStatus.message}`);
        } else {
            console.warn('[Corte Automático] Configuración de correo o dirección de admin para reportes incompleta. No se pudo enviar el reporte por correo.');
        }

    } catch (error) {
        console.error('[Corte Automático] Error al procesar y enviar el corte automático:', error);
    }
}


// Inicialización de archivos si no existen
async function inicializarArchivos() {
    await leerArchivo(CONFIG_FILE, {
        tasa_dolar: 0,
        pagina_bloqueada: false,
        fecha_sorteo: null,
        precio_ticket: 1.00,
        numero_sorteo_correlativo: 1,
        ultimo_numero_ticket: 0,
        ultima_fecha_resultados_zulia: null,
        // Cambiado a array para múltiples números de WhatsApp
        admin_whatsapp_numbers: [], // Formato: ['584121234567', '584149876543']
        mail_config: {
            host: 'smtp.tuservidor.com',
            port: 587,
            secure: false,
            user: 'tu_correo@ejemplo.com',
            pass: 'tu_contraseña_de_correo',
            senderName: 'Notificaciones de Rifas'
        },
        // Dirección de correo actualizada
        admin_email_for_reports: 'SkyFall7k@gmail.com'
    });
    await leerArchivo(VENTAS_FILE, []);
    await leerArchivo(HORARIOS_ZULIA_FILE, { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] });
    await leerArchivo(RESULTADOS_ZULIA_FILE, []);
}

// Llama a la inicialización al arrancar el servidor
inicializarArchivos().catch(err => {
    console.error('Error durante la inicialización de archivos:', err);
    process.exit(1);
});

// --- Rutas de Configuración y Horarios (Panel de Administración) ---

app.get('/api/admin/configuracion', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_FILE, {});
        res.json(config);
    } catch (error) {
        console.error('Error al obtener la configuración:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener la configuración.' });
    }
});

app.put('/api/admin/configuracion', async (req, res) => {
    try {
        const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo, ultimo_numero_ticket, admin_whatsapp_numbers, mail_config, admin_email_for_reports } = req.body; // admin_whatsapp_numbers ahora es un array

        const config = await leerArchivo(CONFIG_FILE, {});

        // Actualizar campos si vienen en la solicitud
        if (tasa_dolar !== undefined) config.tasa_dolar = parseFloat(tasa_dolar);
        if (pagina_bloqueada !== undefined) config.pagina_bloqueada = Boolean(pagina_bloqueada);
        if (fecha_sorteo !== undefined) config.fecha_sorteo = fecha_sorteo;
        if (precio_ticket !== undefined) config.precio_ticket = parseFloat(precio_ticket);
        if (numero_sorteo_correlativo !== undefined) config.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo);
        if (ultimo_numero_ticket !== undefined) config.ultimo_numero_ticket = parseInt(ultimo_numero_ticket);
        if (admin_whatsapp_numbers !== undefined) config.admin_whatsapp_numbers = admin_whatsapp_numbers; // Actualiza el array de números de WhatsApp
        if (mail_config !== undefined) config.mail_config = mail_config;
        if (admin_email_for_reports !== undefined) config.admin_email_for_reports = admin_email_for_reports;

        // Validaciones
        if (isNaN(config.precio_ticket) || config.precio_ticket < 0) config.precio_ticket = 1.00;
        if (isNaN(config.numero_sorteo_correlativo) || config.numero_sorteo_correlativo < 1) config.numero_sorteo_correlativo = 1;
        if (isNaN(config.ultimo_numero_ticket) || config.ultimo_numero_ticket < 0) config.ultimo_numero_ticket = 0;

        await escribirArchivo(CONFIG_FILE, config);
        res.json({ message: 'Configuración actualizada exitosamente', config });
    } catch (error) {
        console.error('Error al actualizar la configuración:', error);
        res.status(500).json({ error: 'Error al guardar la configuración' });
    }
});

app.get('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const horarios = await leerArchivo(HORARIOS_ZULIA_FILE, {});
        res.json(horarios);
    } catch (error) {
        console.error('Error al obtener horarios del Zulia:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener horarios.' });
    }
});

app.put('/api/admin/horarios-zulia', async (req, res) => {
    const { horarios_zulia } = req.body;
    if (!Array.isArray(horarios_zulia)) {
        return res.status(400).json({ error: 'El formato de los horarios debe ser un array.' });
    }
    try {
        await escribirArchivo(HORARIOS_ZULIA_FILE, { horarios_zulia });
        res.json({ message: 'Horarios del Zulia actualizados exitosamente', horarios_zulia });
    } catch (error) {
        console.error('Error al guardar los horarios del Zulia:', error);
        res.status(500).json({ error: 'Error al guardar los horarios del Zulia' });
    }
});

// --- Rutas de Gestión de Ventas (Panel de Administración) ---

app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_FILE, []);
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener la lista de ventas:', error);
        res.status(500).json({ error: 'Error al obtener la lista de ventas.' });
    }
});

app.get('/api/admin/ventas/exportar-excel', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_FILE, []);
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(ventas);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Ventas');
        const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="ventas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(excelBuffer);

    } catch (error) {
        console.error('Error al exportar la lista de ventas a Excel:', error);
        res.status(500).json({ error: 'Error al exportar la lista de ventas a Excel.' });
    }
});

// NUEVA RUTA: Confirmar una venta por ID (desde el panel de administración)
app.put('/api/admin/ventas/:numeroTicket/confirmar', async (req, res) => {
    const numeroTicket = req.params.numeroTicket;

    try {
        let ventas = await leerArchivo(VENTAS_FILE, []);
        const ventaIndex = ventas.findIndex(v => v.numeroTicket === numeroTicket);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        if (ventas[ventaIndex].estado === 'confirmado') {
            return res.status(400).json({ message: 'Esta venta ya ha sido confirmada.' });
        }

        ventas[ventaIndex].estado = 'confirmado';
        ventas[ventaIndex].fechaConfirmacionAdmin = new Date().toISOString();
        await escribirArchivo(VENTAS_FILE, ventas);

        res.json({ message: `Venta ${numeroTicket} confirmada exitosamente.`, venta: ventas[ventaIndex] });
    } catch (error) {
        console.error('Error al confirmar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al confirmar la venta.' });
    }
});

// NUEVA RUTA: Cancelar una venta por ID (desde el panel de administración)
app.put('/api/admin/ventas/:numeroTicket/cancelar', async (req, res) => {
    const numeroTicket = req.params.numeroTicket;

    try {
        let ventas = await leerArchivo(VENTAS_FILE, []);
        const ventaIndex = ventas.findIndex(v => v.numeroTicket === numeroTicket);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        if (ventas[ventaIndex].estado === 'cancelado') {
            return res.status(400).json({ message: 'Esta venta ya ha sido cancelada.' });
        }

        ventas[ventaIndex].estado = 'cancelado';
        ventas[ventaIndex].fechaCancelacionAdmin = new Date().toISOString();
        await escribirArchivo(VENTAS_FILE, ventas);

        res.json({ message: `Venta ${numeroTicket} cancelada exitosamente.`, venta: ventas[ventaIndex] });
    } catch (error) {
        console.error('Error al cancelar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al cancelar la venta.' });
    }
});

// --- NUEVA RUTA: Endpoint para ejecutar el corte de ventas manualmente ---
app.post('/api/admin/execute-sales-cut', async (req, res) => {
    try {
        console.log('Solicitud POST recibida para /api/admin/execute-sales-cut');
        await enviarCorteAutomatico(); // Llama a la función existente
        res.json({ message: 'Corte de ventas ejecutado con éxito. Revisa tu correo y WhatsApp.' });
    } catch (error) {
        console.error('Error al ejecutar el corte de ventas manualmente:', error);
        res.status(500).json({ error: 'Error al ejecutar el corte de ventas. Por favor, revisa los logs del servidor.' });
    }
});


// --- Rutas de Usuarios y Rifas (Placeholders) ---
app.post('/api/admin/usuarios', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Crear - No implementada' });
});
app.get('/api/admin/usuarios', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Obtener todos - No implementada' });
});
app.get('/api/admin/usuarios/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Obtener por ID - No implementada' });
});
app.put('/api/admin/usuarios/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Actualizar - No implementada' });
});
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Eliminar - No implementada' });
});

app.get('/api/admin/rifas', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Obtener todas - No implementada' });
});
app.get('/api/admin/rifas/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Obtener por ID - No implementada' });
});
app.post('/api/admin/rifas', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Crear - No implementada' });
});
app.put('/api/admin/rifas/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Actualizar - No implementada' });
});
app.delete('/api/admin/rifas/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Eliminar - No implementada' });
});

// --- API para Obtener Números DISPONIBLES para el Cliente ---
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_FILE, {});
        const fechaSorteoActual = config.fecha_sorteo;
        const numeroSorteoCorrelativo = config.numero_sorteo_correlativo;
        const paginaBloqueada = config.pagina_bloqueada;

        if (paginaBloqueada) {
            return res.status(200).json({
                numerosDisponibles: [],
                fechaSorteo: fechaSorteoActual,
                numeroSorteoCorrelativo: numeroSorteoCorrelativo,
                paginaBloqueada: true,
                message: 'La página está bloqueada por el administrador. No se pueden realizar compras.'
            });
        }

        if (!fechaSorteoActual) {
            return res.status(200).json({
                numerosDisponibles: [],
                fechaSorteo: null,
                numeroSorteoCorrelativo: numeroSorteoCorrelativo,
                paginaBloqueada: false,
                message: 'No hay una fecha de sorteo configurada. Números no disponibles para la venta.'
            });
        }

        const ventas = await leerArchivo(VENTAS_FILE, []);
        const numerosVendidosParaSorteoActual = new Set();
        ventas.forEach(venta => {
            if (venta.fechaSorteo === fechaSorteoActual && ['pendiente', 'confirmado'].includes(venta.estado)) {
                if (Array.isArray(venta.numeros)) {
                    venta.numeros.forEach(num => numerosVendidosParaSorteoActual.add(num));
                }
            }
        });

        const todosLosNumeros = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
        const numerosDisponibles = todosLosNumeros.filter(num => !numerosVendidosParaSorteoActual.has(num));

        res.json({
            numerosDisponibles: numerosDisponibles,
            fechaSorteo: fechaSorteoActual,
            numeroSorteoCorrelativo: numeroSorteoCorrelativo,
            paginaBloqueada: false
        });

    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener números disponibles.' });
    }
});

// --- API para Registrar una Nueva Venta (¡CON NÚMERO DE TICKET CORRELATIVO Y ESTADO!) ---
app.post('/api/ventas', async (req, res) => {
    try {
        const {
            numeros,
            comprador,
            cedula,
            telefono,
            email,
            metodoPago,
            referenciaPago,
            valorTotalUsd,
            valorTotalBs,
            tasaAplicada,
            fechaCompra,
            fechaSorteo
        } = req.body;

        const currentConfig = await leerArchivo(CONFIG_FILE, {});
        if (currentConfig.pagina_bloqueada) {
            return res.status(403).json({ message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.' });
        }
        if (currentConfig.fecha_sorteo !== fechaSorteo) {
            return res.status(400).json({ message: 'La fecha del sorteo en la solicitud no coincide con la fecha del sorteo actual configurada.' });
        }

        // **Validaciones básicas**
        if (!numeros || numeros.length === 0) {
            return res.status(400).json({ message: 'Debe seleccionar al menos un número.' });
        }
        if (!comprador || comprador.trim() === '') {
            return res.status(400).json({ message: 'El nombre del comprador es obligatorio.' });
        }
        if (!telefono || telefono.trim() === '') {
            return res.status(400).json({ message: 'El teléfono es obligatorio.' });
        }
        if (!metodoPago || metodoPago.trim() === '') {
            return res.status(400).json({ message: 'El método de pago es obligatorio.' });
        }
        if (!referenciaPago || referenciaPago.trim() === '') {
            return res.status(400).json({ message: 'La referencia de pago es obligatoria.' });
        }
        if (!fechaSorteo) {
            return res.status(400).json({ message: 'La fecha del sorteo es obligatoria.' });
        }
        if (isNaN(valorTotalUsd) || isNaN(valorTotalBs) || valorTotalUsd <= 0 || valorTotalBs <= 0) {
            return res.status(400).json({ message: 'Los valores de pago deben ser numéricos y mayores que cero.' });
        }

        // --- VALIDACIÓN DE NÚMEROS YA VENDIDOS PARA ESTE SORTEO Y ESTADO ---
        const ventasExistentes = await leerArchivo(VENTAS_FILE, []);
        const numerosYaVendidosParaEsteSorteo = new Set();
        ventasExistentes.forEach(venta => {
            if (venta.fechaSorteo === fechaSorteo && ['pendiente', 'confirmado'].includes(venta.estado)) {
                if (Array.isArray(venta.numeros)) {
                    venta.numeros.forEach(num => numerosYaVendidosParaEsteSorteo.add(num));
                }
            }
        });

        const numerosDuplicados = numeros.filter(num => numerosYaVendidosParaEsteSorteo.has(num));

        if (numerosDuplicados.length > 0) {
            return res.status(409).json({
                message: `¡Ups! Los siguientes números ya están vendidos para el sorteo del ${fechaSorteo}: ${numerosDuplicados.join(', ')}. Por favor, elige otros.`,
                numeros_conflictivos: numerosDuplicados
            });
        }
        // --- FIN VALIDACIÓN ---

        // Manejo de la subida del comprobante (si se envía)
        let comprobanteUrl = null;
        if (req.files && req.files.comprobante) {
            const comprobanteFile = req.files.comprobante;
            const uploadDir = path.join(__dirname, 'uploads', 'comprobantes');
            await fs.mkdir(uploadDir, { recursive: true });

            const fileExtension = path.extname(comprobanteFile.name);
            const fileName = `${Date.now()}-${comprobanteFile.md5}${fileExtension}`;
            const filePath = path.join(uploadDir, fileName);

            try {
                await comprobanteFile.mv(filePath);
                comprobanteUrl = `/uploads/comprobantes/${fileName}`;
                console.log('Comprobante subido a:', filePath);
            } catch (uploadError) {
                console.error('Error al subir el comprobante:', uploadError);
                comprobanteUrl = null;
            }
        }

        // --- Generar el número de ticket correlativo ---
        const config = await leerArchivo(CONFIG_FILE, {});
        config.ultimo_numero_ticket++;
        await escribirArchivo(CONFIG_FILE, config);

        const numeroTicketGenerado = String(config.ultimo_numero_ticket).padStart(4, '0');

        const nuevaVenta = {
            numeroTicket: numeroTicketGenerado,
            numeros: numeros,
            comprador: comprador,
            cedula: cedula || '',
            telefono: telefono,
            email: email || '',
            metodoPago: metodoPago,
            referenciaPago: referenciaPago,
            valorTotalUsd: parseFloat(valorTotalUsd),
            valorTotalBs: parseFloat(valorTotalBs),
            tasaAplicada: parseFloat(tasaAplicada),
            fechaCompra: fechaCompra || new Date().toISOString(),
            fechaSorteo: fechaSorteo,
            comprobanteUrl: comprobanteUrl,
            estado: 'pendiente',
            numeroSorteoCorrelativo: currentConfig.numero_sorteo_correlativo
        };

        const ventas = await leerArchivo(VENTAS_FILE, []);
        ventas.push(nuevaVenta);
        await escribirArchivo(VENTAS_FILE, ventas);

        console.log('Venta guardada exitosamente:', nuevaVenta.numeroTicket);

        // --- Notificación de nueva venta por WhatsApp (solo al primer número configurado, si existe) ---
        // Se mantiene la notificación inmediata de nueva venta.
        const adminWhatsappNumbersForInstant = config.admin_whatsapp_numbers;
        if (Array.isArray(adminWhatsappNumbersForInstant) && adminWhatsappNumbersForInstant.length > 0) {
            const whatsappLink = generarEnlaceWhatsApp(nuevaVenta, adminWhatsappNumbersForInstant[0]); // Solo al primer número
            if (whatsappLink) {
                console.log('Enlace de notificación WhatsApp (nueva venta) para el administrador:', whatsappLink);
            } else {
                console.warn('No se pudo generar el enlace de WhatsApp (número de admin para notificación de nueva venta no configurado).');
            }
        } else {
            console.warn('No hay números de WhatsApp de administrador configurados para notificación de nueva venta.');
        }


        res.status(201).json({
            message: '¡Venta registrada con éxito!',
            venta: nuevaVenta
        });

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ error: 'Hubo un error al registrar tu venta. Por favor, intenta de nuevo.' });
    }
});

// --- Rutas de Gestión de Resultados de Lotería Zulia ---

// Obtener resultados históricos
app.get('/api/admin/resultados-zulia', async (req, res) => {
    try {
        const resultados = await leerArchivo(RESULTADOS_ZULIA_FILE, []);
        res.json(resultados);
    } catch (error) {
        console.error('Error al obtener resultados del Zulia:', error);
        res.status(500).json({ error: 'Error al obtener los resultados del Zulia.' });
    }
});

// Simular la obtención de resultados de una API externa (¡REEMPLAZAR CON API REAL!)
app.get('/api/admin/obtener-resultados-externos', async (req, res) => {
    try {
        const mockResults = {
            zuliaNumeros: {
                "12:00 PM": "123",
                "04:00 PM": "456",
                "07:00 PM": "789"
            },
            fecha: req.query.fecha || new Date().toISOString().split('T')[0]
        };

        res.json({ success: true, message: 'Resultados simulados obtenidos.', resultados: mockResults.zuliaNumeros });

    } catch (error) {
        console.error('Error al obtener resultados de la API externa (simulada):', error);
        res.status(500).json({ success: false, message: `Error al conectar con la API de resultados: ${error.message}` });
    }
});

// Guardar los números ganadores del Zulia para un sorteo específico
app.post('/api/admin/guardar-numeros-ganadores-zulia', async (req, res) => {
    const { fecha_sorteo, numeros_ganadores, hora_sorteo } = req.body;

    if (!fecha_sorteo || !numeros_ganadores || !hora_sorteo) {
        return res.status(400).json({ message: 'Faltan datos obligatorios: fecha_sorteo, hora_sorteo, numeros_ganadores.' });
    }

    try {
        let resultados = await leerArchivo(RESULTADOS_ZULIA_FILE, []);

        // Busca si ya existe un resultado para esa fecha y hora
        const existingIndex = resultados.findIndex(
            r => r.fecha_sorteo === fecha_sorteo && r.hora_sorteo === hora_sorteo
        );

        const nuevoResultado = {
            fecha_sorteo: fecha_sorteo,
            hora_sorteo: hora_sorteo,
            numeros: numeros_ganadores,
            timestamp: new Date().toISOString()
        };

        if (existingIndex !== -1) {
            // Actualiza el resultado existente
            resultados[existingIndex] = nuevoResultado;
        } else {
            // Agrega el nuevo resultado
            resultados.push(nuevoResultado);
        }

        await escribirArchivo(RESULTADOS_ZULIA_FILE, resultados);

        // Opcional: Actualizar la última fecha de resultados buscados en la configuración
        const config = await leerArchivo(CONFIG_FILE, {});
        config.ultima_fecha_resultados_zulia = fecha_sorteo;
        await escribirArchivo(CONFIG_FILE, config);

        res.json({ success: true, message: 'Resultados de Zulia guardados/actualizados con éxito.', resultados: nuevoResultado });
    } catch (error) {
        console.error('Error al guardar los números ganadores del Zulia:', error);
        res.status(500).json({ success: false, message: `Error al guardar los resultados: ${error.message}` });
    }
});


// --- API para Obtener Términos y Condiciones ---
app.get('/api/terminos-condiciones', async (req, res) => {
    try {
        const terminos = await fs.readFile(TERMINOS_CONDICIONES_FILE, 'utf8');
        res.send(terminos);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).send('Archivo de términos y condiciones no encontrado.');
        }
        console.error('Error al leer términos y condiciones:', error);
        res.status(500).send('Error interno del servidor al obtener términos y condiciones.');
    }
});

// --- API para Actualizar Términos y Condiciones (Panel de Administración) ---
app.put('/api/admin/terminos-condiciones', async (req, res) => {
    const { content } = req.body;
    if (typeof content !== 'string') {
        return res.status(400).json({ message: 'El contenido debe ser una cadena de texto.' });
    }
    try {
        await fs.writeFile(TERMINOS_CONDICIONES_FILE, content, 'utf8');
        res.json({ message: 'Términos y condiciones actualizados exitosamente.' });
    } catch (error) {
        console.error('Error al actualizar términos y condiciones:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar términos y condiciones.' });
    }
});


// --- Programador de Tareas (Cron Jobs) ---
// Tarea programada para enviar el corte automático de ventas
// Se ejecutará todos los días a las 00:00 (medianoche)
// Puedes ajustar la hora según tus necesidades.
// Ejemplo: '0 0 * * *' significa 0 minutos, 0 horas, cualquier día del mes, cualquier mes, cualquier día de la semana.
cron.schedule('0 0 * * *', async () => {
    console.log('Ejecutando tarea programada: enviarCorteAutomatico');
    await enviarCorteAutomatico();
}, {
    timezone: "America/Caracas" // Asegúrate de ajustar la zona horaria a la de Venezuela
});


// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor backend corriendo en http://localhost:${port}`);
});
