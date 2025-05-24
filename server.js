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

dotenv.config();

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
app.use(express.json()); // Permite a Express parsear JSON en el body de las solicitudes
app.use(express.urlencoded({ extended: true })); // Permite a Express parsear datos de formulario URL-encoded

// Configuración de express-fileupload (añade este límite para evitar problemas con archivos grandes)
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Límite de 50MB (50 * 1024 * 1024 bytes)
    abortOnLimit: true, // Si el archivo excede el límite, abortar la carga
    responseOnLimit: 'El tamaño del archivo excede el límite permitido (50MB).', // Mensaje de error
}));

// --- Rutas de archivos de datos (Asegúrate de que sean correctas) ---
const DATA_DIR = path.join(__dirname, 'data'); // Carpeta para tus archivos JSON
const CONFIG_PATH = path.join(DATA_DIR, 'configuracion.json');
const NUMEROS_PATH = path.join(DATA_DIR, 'numeros.json');
const VENTAS_PATH = path.join(DATA_DIR, 'ventas.json');
const CORTES_PATH = path.join(DATA_DIR, 'cortes.json');
const HORARIOS_ZULIA_PATH = path.join(DATA_DIR, 'horarios_zulia.json'); // Nueva ruta para horarios Zulia

// Asegurarse de que el directorio 'data' existe
(async () => {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        console.log(`Directorio de datos '${DATA_DIR}' verificado/creado.`);
    } catch (error) {
        console.error(`Error al crear el directorio de datos: ${error.message}`);
    }
})();

// Función auxiliar para leer archivos JSON
async function leerArchivo(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        if (data.trim() === '') { // Si el archivo está vacío
            await escribirArchivo(filePath, defaultValue);
            console.warn(`⚠️ Archivo ${path.basename(filePath)} estaba vacío, recreado con valor por defecto.`);
            return defaultValue;
        }
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // Si el archivo no existe
            await escribirArchivo(filePath, defaultValue);
            console.warn(`⚠️ Archivo ${path.basename(filePath)} no existe, creado con valor por defecto.`);
            return defaultValue;
        } else if (error instanceof SyntaxError) { // Si el JSON está malformado
            await escribirArchivo(filePath, defaultValue);
            console.error(`❌ Archivo ${path.basename(filePath)} corrupto (${error.message}), recreado con valor por defecto.`);
            return defaultValue;
        }
        throw error; // Propagar otros errores
    }
}

// Función auxiliar para escribir en archivos JSON
async function escribirArchivo(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Configuración de Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail', // o tu servicio de correo
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Función de corte de ventas (DEBES ASEGURARTE DE QUE ESTA FUNCIÓN ESTÉ DEFINIDA EN ALGÚN LUGAR DE TU CÓDIGO)
async function executeSalesCut(auto = false) {
    console.log(`Ejecutando corte de ventas (automático: ${auto}) en ${moment().tz("America/Caracas").format()}`);
    try {
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });
        const cortesData = await leerArchivo(CORTES_PATH, { cortes: [] });

        // Obtener la fecha del sorteo actual de la configuración
        const config = await leerArchivo(CONFIG_PATH, {});
        const fechaSorteoActual = config.fecha_sorteo;

        if (!fechaSorteoActual) {
            console.warn('No hay fecha de sorteo actual configurada para realizar el corte.');
            return; // O manejar como error
        }

        // Filtra las ventas para el sorteo actual que no han sido cortadas
        const ventasDelSorteoActual = ventasData.ventas.filter(venta =>
            moment(venta.fechaSorteo).format('YYYY-MM-DD') === moment(fechaSorteoActual).format('YYYY-MM-DD')
        );

        // Si no hay ventas para el sorteo actual, no hay nada que cortar
        if (ventasDelSorteoActual.length === 0) {
            console.log('No hay ventas para el sorteo actual, no se realiza corte.');
            return;
        }

        // Crear un nuevo registro de corte
        const nuevoCorte = {
            id: Date.now(),
            fechaCorte: moment().tz("America/Caracas").toISOString(),
            fechaSorteo: fechaSorteoActual,
            ventas: ventasDelSorteoActual, // Guardar las ventas de este corte
            totalTickets: ventasDelSorteoActual.length,
            totalUsd: ventasDelSorteoActual.reduce((sum, venta) => sum + venta.valorTotalUsd, 0),
            totalBs: ventasDelSorteoActual.reduce((sum, venta) => sum + venta.valorTotalBs, 0),
            tipo: auto ? 'automatico' : 'manual'
        };

        cortesData.cortes.push(nuevoCorte);
        await escribirArchivo(CORTES_PATH, cortesData);

        // Limpiar ventas y resetear números disponibles
        await escribirArchivo(VENTAS_PATH, { ventas: [] }); // Eliminar ventas pasadas

        const numerosReset = Array.from({ length: 100 }, (_, i) => ({ numero: (i + 1).toString().padStart(2, '0'), disponible: true }));
        await escribirArchivo(NUMEROS_PATH, { numeros: numerosReset });

        // Opcional: Avanzar la fecha del sorteo o reiniciarla, y reiniciar el correlativo
        // Esto depende de cómo quieras manejar los sorteos futuros
        config.fecha_sorteo = null; // Reiniciar la fecha de sorteo
        config.numero_sorteo_correlativo = 1; // Reiniciar el correlativo de tickets
        await escribirArchivo(CONFIG_PATH, config);

        console.log(`✅ Corte de ventas para el sorteo del ${fechaSorteoActual} realizado exitosamente.`);

        // Lógica de envío de correo de reporte de corte al admin (similar a la de ventas)
        const adminEmailForReports = config.admin_email_for_reports;
        if (adminEmailForReports) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: adminEmailForReports,
                subject: `REPORTE DE CORTE DE VENTAS - Sorteo ${moment(fechaSorteoActual).format('DD/MM/YYYY')}`,
                html: `
                    <h2>Reporte de Corte de Ventas</h2>
                    <p>Se ha realizado un corte de ventas para el sorteo del día <strong>${moment(fechaSorteoActual).format('DD/MM/YYYY')}</strong>.</p>
                    <p><strong>Fecha y Hora del Corte:</strong> ${moment(nuevoCorte.fechaCorte).format('DD/MM/YYYY HH:mm')}</p>
                    <p><strong>Tipo de Corte:</strong> ${nuevoCorte.tipo}</p>
                    <h3>Resumen del Sorteo</h3>
                    <ul>
                        <li>Total de Tickets Vendidos: <strong>${nuevoCorte.totalTickets}</strong></li>
                        <li>Total Recaudado (USD): <strong>$${nuevoCorte.totalUsd.toFixed(2)}</strong></li>
                        <li>Total Recaudado (Bs): <strong>Bs ${nuevoCorte.totalBs.toFixed(2)}</strong></li>
                    </ul>
                    <p>Los números han sido reseteados y las ventas correspondientes han sido archivadas.</p>
                    <p>Saludos cordiales,</p>
                    <p>Tu Equipo de Rifas</p>
                `
            };
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    console.error('Error al enviar reporte de corte al administrador:', error);
                } else {
                    console.log('Reporte de corte enviado al administrador:', info.response);
                }
            });
        }

    } catch (error) {
        console.error('❌ Error en executeSalesCut:', error);
        // Manejar el error apropiadamente, quizás notificar al administrador
    }
}


// ========================================================================
// === INICIO DE BLOQUE DE VERIFICACIÓN/REPARACIÓN DE ARCHIVOS CRÍTICOS ===
// ========================================================================
// Este bloque es fundamental para la inicialización.
app.listen(port, async () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
    console.log('ℹ️ Iniciando verificación y posible reparación de archivos .json...');
    const filesToVerify = [
        { path: CONFIG_PATH, default: { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1, mail_config: {}, admin_email_for_reports: '' } },
        { path: NUMEROS_PATH, default: { numeros: Array.from({ length: 100 }, (_, i) => ({ numero: (i + 1).toString().padStart(2, '0'), disponible: true })) } }, // Asegura que se inicialicen todos los números
        { path: VENTAS_PATH, default: { ventas: [] } },
        { path: CORTES_PATH, default: { cortes: [] } },
        { path: HORARIOS_ZULIA_PATH, default: { horarios_zulia: ["01:00 PM", "04:00 PM", "07:00 PM"] } } // Horarios por defecto
    ];

    for (const file of filesToVerify) {
        try {
            const content = await fs.readFile(file.path, 'utf8');
            JSON.parse(content);
            console.log(`✅ Archivo ${path.basename(file.path)} se leyó y parseó correctamente.`);
        } catch (error) {
            console.warn(`⚠️ Archivo ${path.basename(file.path)} está corrupto, vacío o no existe. Intentando recrearlo con valor por defecto...`, error.message);
            try {
                await escribirArchivo(file.path, file.default);
                console.log(`✅ Archivo ${path.basename(file.path)} recreado con éxito a un estado vacío/por defecto válido.`);
            } catch (writeError) {
                console.error(`❌ ERROR CRÍTICO: No se pudo recrear ${path.basename(file.path)}.`, writeError);
            }
        }
    }
    console.log('--- Verificación de archivos .json completada. ---');

    // Iniciar el cron job para el corte de ventas
    cron.schedule('0 0 * * *', async () => { // Todos los días a medianoche (00:00)
        console.log('✨ Ejecutando tarea programada de corte de ventas...');
        await executeSalesCut(true); // Llamar a la función de corte con 'true' para indicar que es automático
    }, {
        timezone: "America/Caracas" // Asegúrate de que tu timezone sea el correcto
    });
});
// ========================================================================
// === FIN DE BLOQUE DE VERIFICACIÓN/REPARACIÓN DE ARCHIVOS CRÍTICOS ===
// ========================================================================


// --- Rutas del API ---

// Ruta para obtener configuración (panel del cliente y admin)
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH, {});
        // Ocultar información sensible si es para el cliente
        const clientConfig = {
            fecha_sorteo: config.fecha_sorteo,
            precio_ticket: config.precio_ticket,
            tasa_dolar: config.tasa_dolar,
            pagina_bloqueada: config.pagina_bloqueada,
            numero_sorteo_correlativo: config.numero_sorteo_correlativo
        };
        res.json(clientConfig);
    } catch (error) {
        console.error('❌ Error al obtener configuración para el cliente:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// Ruta para obtener todos los números disponibles
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });
        res.json(numerosData.numeros);
    } catch (error) {
        console.error('❌ Error al obtener números disponibles:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.' });
    }
});

// Ruta para obtener horarios del Zulia (para el cliente)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horariosData = await leerArchivo(HORARIOS_ZULIA_PATH, { horarios_zulia: [] });
        res.json(horariosData.horarios_zulia);
    } catch (error) {
        console.error('❌ Error al obtener horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
});


// Ruta para registrar una nueva venta
app.post('/api/ventas', async (req, res) => {
    console.log('--- Nueva solicitud POST /api/ventas ---');
    console.log('req.body:', req.body);
    console.log('req.files:', req.files);

    try {
        const config = await leerArchivo(CONFIG_PATH, {});
        const { comprador, telefono, codigoPais, cedula, email, metodoPago, referenciaPago, numeros, valorTotalUsd, valorTotalBs, tasaAplicada, fechaSorteo } = req.body;
        const comprobanteAdjunto = req.files && req.files.comprobante;

        // ==========================================
        // === VALIDACIONES (CRÍTICO PARA EL 400) ===
        // ==========================================

        if (config.pagina_bloqueada) {
            console.log('❌ VALIDACION FALLIDA: Página bloqueada.');
            return res.status(403).json({ message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.' });
        }
        if (!config.fecha_sorteo) {
            console.log('❌ VALIDACION FALLIDA: No hay fecha de sorteo configurada.');
            return res.status(400).json({ message: 'No hay una fecha de sorteo configurada por el administrador.' });
        }

        const fechaSorteoFrontend = moment.tz(fechaSorteo, "America/Caracas").format('YYYY-MM-DD');
        const fechaSorteoBackend = moment.tz(config.fecha_sorteo, "America/Caracas").format('YYYY-MM-DD');

        console.log(`Comparando fechas: Frontend='${fechaSorteoFrontend}' vs Backend='${fechaSorteoBackend}'`);
        if (fechaSorteoFrontend !== fechaSorteoBackend) {
            console.log('❌ VALIDACION FALLIDA: Fechas de sorteo no coinciden.');
            return res.status(400).json({ message: `La fecha del sorteo en la solicitud (${fechaSorteoFrontend}) no coincide con la fecha del sorteo actual configurada (${fechaSorteoBackend}). Por favor, recargue la página.` });
        }

        if (!comprador || !telefono || !codigoPais || !cedula || !email || !metodoPago || !referenciaPago || !numeros || numeros.length === 0 || valorTotalUsd === undefined || valorTotalBs === undefined || tasaAplicada === undefined) {
            console.log('❌ VALIDACION FALLIDA: Faltan campos obligatorios o números.');
            return res.status(400).json({ message: 'Faltan campos obligatorios o números seleccionados.' });
        }
        if (!Array.isArray(numeros) || numeros.length === 0) {
            console.log('❌ VALIDACION FALLIDA: Numeros no es un array o está vacío.');
            return res.status(400).json({ message: 'Debe seleccionar al menos un número (formato: array de strings).' });
        }
        if (isNaN(parseFloat(valorTotalUsd)) || isNaN(parseFloat(valorTotalBs)) || isNaN(parseFloat(tasaAplicada))) {
            console.log('❌ VALIDACION FALLIDA: Valores numéricos inválidos (USD, Bs, Tasa).');
            return res.status(400).json({ message: 'Valores numéricos inválidos (USD, Bs, Tasa).' });
        }

        // ==========================================
        // === PROCESAMIENTO DEL ARCHIVO (IMAGEN) ===
        // ==========================================
        let comprobantePath = null;
        if (comprobanteAdjunto) {
            const fileName = `${Date.now()}_${comprobanteAdjunto.name}`;
            const uploadPath = path.join(__dirname, 'uploads', fileName); // Guardar en una carpeta 'uploads'
            try {
                await comprobanteAdjunto.mv(uploadPath);
                comprobantePath = `/uploads/${fileName}`; // Ruta pública para acceder al comprobante
                console.log(`✅ Comprobante '${fileName}' guardado en '${uploadPath}'`);
            } catch (err) {
                console.error('❌ Error al guardar el comprobante:', err);
                return res.status(500).json({ message: 'Error al subir el comprobante.' });
            }
        } else {
            console.log('ℹ️ No se adjuntó comprobante.');
        }

        // ==========================================
        // === REGISTRO DE VENTA Y ACTUALIZACIÓN ===
        // ==========================================

        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        const numerosDisponiblesData = await leerArchivo(NUMEROS_PATH, { numeros: [] });

        // Verificar y marcar números como no disponibles
        const numerosInvalidos = [];
        const numerosActualizados = numerosDisponiblesData.numeros.map(n => {
            if (numeros.includes(n.numero)) {
                if (n.disponible) {
                    n.disponible = false;
                } else {
                    numerosInvalidos.push(n.numero);
                }
            }
            return n;
        });

        if (numerosInvalidos.length > 0) {
            console.log('❌ VALIDACION FALLIDA: Numeros ya no disponibles.');
            return res.status(400).json({ message: `Los siguientes números ya no están disponibles: ${numerosInvalidos.join(', ')}. Por favor, recargue la página.` });
        }

        const numeroComprobante = `REF-${Date.now()}`; // Generar un número de comprobante único

        // Incrementar el número de sorteo correlativo y usarlo
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1;
        const numeroTicketCorrelativo = config.numero_sorteo_correlativo;
        await escribirArchivo(CONFIG_PATH, config); // Guardar la configuración actualizada

        const nuevaVenta = {
            id: Date.now(), // ID único para la venta
            numeroComprobante: numeroComprobante,
            numeroTicket: numeroTicketCorrelativo, // Nuevo campo
            comprador,
            telefono: `${codigoPais}${telefono}`,
            cedula,
            email,
            metodoPago,
            referenciaPago,
            numeros,
            valorTotalUsd: parseFloat(valorTotalUsd),
            valorTotalBs: parseFloat(valorTotalBs),
            tasaAplicada: parseFloat(tasaAplicada),
            fechaCompra: moment().tz("America/Caracas").toISOString(),
            fechaSorteo: fechaSorteoFrontend, // Usar la fecha del frontend ya formateada
            comprobanteAdjunto: comprobantePath,
            // Puedes añadir un estado de confirmación inicial aquí, ej: estado: 'pendiente'
        };

        ventasData.ventas.push(nuevaVenta);

        await escribirArchivo(VENTAS_PATH, ventasData);
        await escribirArchivo(NUMEROS_PATH, { numeros: numerosActualizados });

        console.log('✅ Venta registrada y números actualizados. Enviando notificaciones...');

        // ==========================================
        // === ENVÍO DE CORREOS Y WHATSAPP ===
        // ==========================================
        // Simulación de envío de correo (adapta esto a tu lógica real)
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email, // Correo del comprador
            subject: `Confirmación de Compra de Ticket ${numeroTicketCorrelativo}`,
            html: `
                <h1>¡Gracias por tu compra!</h1>
                <p>Tu número de ticket es: <strong>${numeroTicketCorrelativo}</strong></p>
                <p>Comprobante de referencia: <strong>${numeroComprobante}</strong></p>
                <p>Números seleccionados: <strong>${numeros.join(', ')}</strong></p>
                <p>Total pagado: <strong>$${nuevaVenta.valorTotalUsd.toFixed(2)} / Bs ${nuevaVenta.valorTotalBs.toFixed(2)}</strong></p>
                <p>Fecha del sorteo: <strong>${moment(nuevaVenta.fechaSorteo).format('DD/MM/YYYY')}</strong></p>
                <p>Te deseamos mucha suerte!</p>
                <p>Atentamente, Tu Equipo de Rifas</p>
            `,
            attachments: comprobantePath ? [{ path: path.join(__dirname, 'uploads', path.basename(comprobantePath)) }] : []
        };

        // Envía el correo al comprador
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Error al enviar correo al comprador:', error);
            } else {
                console.log('Correo al comprador enviado:', info.response);
            }
        });

        // Envía un correo al administrador (si configurado)
        if (config.admin_email_for_reports && config.admin_email_for_reports.length > 0) {
            const adminMailOptions = {
                from: process.env.EMAIL_USER,
                to: config.admin_email_for_reports,
                subject: `NUEVA VENTA REGISTRADA: Ticket ${numeroTicketCorrelativo} de ${comprador}`,
                html: `
                    <h2>Nueva Venta Registrada</h2>
                    <p><strong>Comprador:</strong> ${comprador}</p>
                    <p><strong>Teléfono:</strong> ${nuevaVenta.telefono}</p>
                    <p><strong>Cédula:</strong> ${cedula}</p>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Ticket #:</strong> ${numeroTicketCorrelativo}</p>
                    <p><strong>Referencia #:</strong> ${numeroComprobante}</p>
                    <p><strong>Números:</strong> ${numeros.join(', ')}</p>
                    <p><strong>Método de Pago:</strong> ${metodoPago}</p>
                    <p><strong>Ref. Pago:</strong> ${referenciaPago}</p>
                    <p><strong>Total USD:</strong> $${nuevaVenta.valorTotalUsd.toFixed(2)}</p>
                    <p><strong>Total Bs:</strong> Bs ${nuevaVenta.valorTotalBs.toFixed(2)}</p>
                    <p><strong>Tasa Aplicada:</strong> ${nuevaVenta.tasaAplicada.toFixed(2)}</p>
                    <p><strong>Fecha Compra:</strong> ${moment(nuevaVenta.fechaCompra).format('DD/MM/YYYY HH:mm')}</p>
                    <p><strong>Fecha Sorteo:</strong> ${moment(nuevaVenta.fechaSorteo).format('DD/MM/YYYY')}</p>
                    ${comprobantePath ? `<p><a href="${API_BASE_URL}${comprobantePath}" target="_blank">Ver Comprobante Adjunto</a></p>` : '<p>No se adjuntó comprobante.</p>'}
                `,
                attachments: comprobantePath ? [{ path: path.join(__dirname, 'uploads', path.basename(comprobantePath)) }] : []
            };

            transporter.sendMail(adminMailOptions, (error, info) => {
                if (error) {
                    console.error('Error al enviar correo al administrador:', error);
                } else {
                    console.log('Correo al administrador enviado:', info.response);
                }
            });
        }

        res.status(201).json({
            message: 'Compra confirmada exitosamente!',
            ticket: nuevaVenta,
            // Puedes devolver más info si necesitas que el frontend la muestre
            // Ej: numeroTicketCorrelativo: nuevaVenta.numeroTicket
        });

    } catch (error) {
        console.error('❌ Error al procesar la venta:', error);
        // Siempre devuelve un JSON en caso de error
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});

// Admin routes (¡Descomentadas!)
// Ruta para obtener configuración de administración (todos los detalles)
app.get('/api/admin/configuracion', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH, {});
        // Aquí puedes devolver la configuración completa, ya que es para el admin
        res.json(config);
    } catch (error) {
        console.error('❌ Error al obtener configuración para el administrador:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración de administración.' });
    }
});

// Ruta para actualizar configuración de administración
app.put('/api/admin/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        // Validación básica (ajusta según tus necesidades)
        if (!newConfig || Object.keys(newConfig).length === 0) {
            return res.status(400).json({ message: 'Datos de configuración inválidos.' });
        }

        let currentConfig = await leerArchivo(CONFIG_PATH, {});
        // Fusionar la configuración existente con la nueva
        currentConfig = { ...currentConfig, ...newConfig };

        await escribirArchivo(CONFIG_PATH, currentConfig);
        res.json({ message: 'Configuración actualizada exitosamente!', config: currentConfig });
    } catch (error) {
        console.error('❌ Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});

// Ruta para obtener horarios del Zulia (para el admin, puede ser la misma que para el cliente)
app.get('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const horariosData = await leerArchivo(HORARIOS_ZULIA_PATH, { horarios_zulia: [] });
        res.json(horariosData.horarios_zulia);
    } catch (error) {
        console.error('❌ Error al obtener horarios del Zulia (admin):', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios del Zulia.' });
    }
});

// Ruta para actualizar horarios del Zulia
app.put('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const { horarios_zulia } = req.body;
        if (!Array.isArray(horarios_zulia)) {
            return res.status(400).json({ message: 'El formato de horarios_zulia debe ser un array.' });
        }
        await escribirArchivo(HORARIOS_ZULIA_PATH, { horarios_zulia });
        res.json({ message: 'Horarios del Zulia actualizados exitosamente!' });
    } catch (error) {
        console.error('❌ Error al actualizar horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar horarios del Zulia.' });
    }
});

// Ruta para obtener todas las ventas (para el admin)
app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        res.json(ventasData.ventas);
    } catch (error) {
        console.error('❌ Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.' });
    }
});

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
    console.error('❌ Error general del servidor:', err.stack);
    res.status(500).json({ message: 'Algo salió mal en el servidor!', error: err.message });
});