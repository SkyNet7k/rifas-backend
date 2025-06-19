// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone'); // Asegúrate de tener moment-timezone instalado: npm install moment-timezone exceljs
const archiver = require('archiver'); // NUEVO: Importar archiver

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
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    useTempFiles: true,
    tempFileDir: '/tmp/' // Directorio temporal para archivos grandes
}));

// Rutas a tus archivos JSON
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json'); // Usado para Zulia y Chance en el frontend
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const COMPROBANTES_FILE = path.join(__dirname, 'comprobantes.json');
const RESULTADOS_SORTEO_FILE = path.join(__dirname, 'resultados_sorteo.json'); // Archivo para guardar resultados del sorteo por hora/tipo
const PREMIOS_FILE = path.join(__dirname, 'premios.json'); // Precios de los premios por hora
const GANADORES_FILE = path.join(__dirname, 'ganadores.json'); // NUEVO: Archivo para guardar tickets ganadores procesados

// Lista de todos los archivos de la base de datos para exportar
const DATABASE_FILES = [
    CONFIG_FILE,
    NUMEROS_FILE,
    HORARIOS_ZULIA_FILE,
    VENTAS_FILE,
    COMPROBANTES_FILE,
    RESULTADOS_SORTEO_FILE,
    PREMIOS_FILE,
    GANADORES_FILE // Incluir el nuevo archivo de ganadores
];


// Directorios para guardar comprobantes y reportes
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const REPORTS_DIR = path.join(__dirname, 'reports');

// Función para asegurar que los directorios existan
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        await fs.mkdir(REPORTS_DIR, { recursive: true });
        // Asegurarse de que los archivos JSON existen con contenido inicial
        await Promise.all([
            ensureJsonFile(CONFIG_FILE, {
                "precio_ticket": 0.50,
                "tasa_dolar": 36.50, // Valor numérico por defecto
                "fecha_sorteo": moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD'),
                "numero_sorteo_correlativo": 1,
                "ultimo_numero_ticket": 0,
                "pagina_bloqueada": false,
                "mail_config": {
                    "host": "smtp.gmail.com",
                    "port": 465,
                    "secure": true, // Cambiado a true para 465
                    "user": process.env.EMAIL_USER || "tu_correo@gmail.com", // Usar variable de entorno o placeholder
                    "pass": process.env.EMAIL_PASS || "tu_contraseña_o_app_password",   // Usar variable de entorno o placeholder
                    "senderName": "Sistema de Rifas"
                },
                "admin_whatsapp_numbers": [],
                "admin_email_for_reports": ["tu_correo@gmail.com"], // Ahora es un array por defecto
                "ultima_fecha_resultados_zulia": null
            }),
            ensureJsonFile(NUMEROS_FILE, Array.from({ length: 1000 }, (_, i) => ({
                numero: i.toString().padStart(3, '0'),
                comprado: false
            }))),
            ensureJsonFile(HORARIOS_ZULIA_FILE, {
                zulia: ["12:00 PM", "04:00 PM", "07:00 PM"],
                chance: ["01:00 PM", "05:00 PM", "08:00 PM"] // Ejemplo de horarios de Chance
            }),
            ensureJsonFile(VENTAS_FILE, []),
            ensureJsonFile(COMPROBANTES_FILE, []),
            ensureJsonFile(RESULTADOS_SORTEO_FILE, []), // Inicializa como array vacío
            ensureJsonFile(PREMIOS_FILE, {}), // Inicializa como objeto vacío para almacenar por fecha/hora
            ensureJsonFile(GANADORES_FILE, []) // NUEVO: Inicializar ganadores.json como array vacío
        ]);
        console.log('Directorios y archivos JSON iniciales asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios o archivos JSON:', error);
    }
}

// Función auxiliar para asegurar que un archivo JSON existe con contenido inicial
async function ensureJsonFile(filePath, defaultContent) {
    try {
        await fs.access(filePath); // Intenta acceder al archivo
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Si el archivo no existe, lo crea con el contenido por defecto
            await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
            console.log(`Creado archivo ${path.basename(filePath)} con contenido por defecto.`);
        } else {
            throw error; // Lanza otros errores
        }
    }
}


// Función auxiliar para leer un archivo JSON
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        // Manejar el caso de archivo vacío (ej. "[]" o "{}")
        if (data.trim() === '') {
            if (filePath === VENTAS_FILE || filePath === RESULTADOS_SORTEO_FILE || filePath === COMPROBANTES_FILE || filePath === NUMEROS_FILE || filePath === GANADORES_FILE) {
                return [];
            }
            return {};
        }
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error leyendo ${path.basename(filePath)}:`, error);
        // Si el archivo no existe o está vacío/corrupto, devuelve un objeto o array vacío
        if (filePath === VENTAS_FILE || filePath === RESULTADOS_SORTEO_FILE || filePath === COMPROBANTES_FILE || filePath === NUMEROS_FILE || filePath === GANADORES_FILE) {
            return [];
        }
        return {};
    }
}

// Función auxiliar para escribir en un archivo JSON
async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let configuracion = {};
let numeros = []; // Esta es la variable global que necesita actualizarse
let horariosZulia = { horarios_zulia: [] }; // Objeto para horarios, no solo array
let ventas = [];
let comprobantes = [];
let resultadosSorteo = [];
let premios = {};
let ganadoresSorteos = []; // NUEVO: Variable global para almacenar los ganadores de los sorteos procesados


// Carga inicial de datos
async function loadInitialData() {
    try {
        configuracion = await readJsonFile(CONFIG_FILE);
        numeros = await readJsonFile(NUMEROS_FILE);
        // MODIFICACIÓN: Asegurar que zulia y chance sean arrays, incluso si el archivo está vacío o malformado
        const loadedHorariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE);
        horariosZulia = {
            zulia: Array.isArray(loadedHorariosZulia.zulia) ? loadedHorariosZulia.zulia : [],
            chance: Array.isArray(loadedHorariosZulia.chance) ? loadedHorariosZulia.chance : []
        };
        ventas = await readJsonFile(VENTAS_FILE);
        comprobantes = await readJsonFile(COMPROBANTES_FILE);
        resultadosSorteo = await readJsonFile(RESULTADOS_SORTEO_FILE); // Leer el nuevo archivo
        premios = await readJsonFile(PREMIOS_FILE);
        ganadoresSorteos = await readJsonFile(GANADORES_FILE); // NUEVO: Cargar el archivo de ganadores

        console.log('Datos iniciales cargados.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
    }
}

// Configuración de Nodemailer
let transporter;
function configureMailer() {
    // Usar variables de entorno si están disponibles, de lo contrario, usar configuracion.json
    const emailUser = process.env.EMAIL_USER || configuracion.mail_config.user;
    const emailPass = process.env.EMAIL_PASS || configuracion.mail_config.pass;

    if (configuracion.mail_config && emailUser && emailPass) {
        transporter = nodemailer.createTransport({
            host: configuracion.mail_config.host,
            port: configuracion.mail_config.port,
            secure: configuracion.mail_config.secure, // Usar el valor de secure de la configuración
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });
        console.log('Nodemailer configurado.');
    } else {
        console.warn('Configuración de correo incompleta. El envío de correos no funcionará.');
        transporter = null; // Asegura que transporter sea null si no se puede configurar
    }
}

// --- Funciones para enviar correos ---
/**
 * Envía un correo electrónico utilizando el transporter configurado.
 * Ahora 'to' puede ser una cadena de texto (un solo correo) o un array de cadenas (múltiples correos).
 * @param {string|string[]} to - Dirección(es) de correo del destinatario(s).
 * @param {string} subject - Asunto del correo.
 * @param {string} html - Contenido HTML del correo.
 * @param {Array} attachments - Array de adjuntos para el correo (opcional).
 * @returns {Promise<boolean>} True si el correo se envió con éxito, false en caso contrario.
 */
async function sendEmail(to, subject, html, attachments = []) {
    if (!transporter) {
        console.error('Mailer no configurado. No se pudo enviar el correo.');
        return false;
    }
    try {
        // Convierte el array de 'to' en una cadena separada por comas, si es un array.
        // Nodemailer puede manejar tanto strings como arrays para el campo 'to'.
        const recipients = Array.isArray(to) ? to.join(',') : to;
        const mailOptions = {
            from: `${configuracion.mail_config.senderName || 'Sistema de Rifas'} <${configuracion.mail_config.user}>`,
            to: recipients,
            subject,
            html,
            attachments // Pasa los adjuntos directamente
        };
        await transporter.sendMail(mailOptions);
        console.log('Correo enviado exitosamente.');
        return true;
    } catch (error) {
        console.error('Error al enviar correo:', error);
        return false;
    }
}


// --- CRON JOBS (si los tienes definidos) ---
/*
// Ejemplo: Reiniciar tickets diarios a medianoche
cron.schedule('0 0 * * *', async () => {
    console.log('Ejecutando tarea diaria: Reiniciar tickets...');
    // Lógica para reiniciar tickets o realizar otras tareas diarias
    // await reiniciarTicketsDiarios();
});
*/

// --- RUTAS DE LA API ---

// Obtener configuración
app.get('/api/configuracion', async (req, res) => {
    // Asegurarse de no enviar credenciales sensibles
    const configToSend = { ...configuracion };
    delete configToSend.mail_config;
    res.json(configToSend);
});

// Actualizar configuración (Cambiado de POST a PUT)
app.put('/api/configuracion', async (req, res) => {
    const newConfig = req.body;
    try {
        // Fusionar solo los campos permitidos y existentes
        Object.keys(newConfig).forEach(key => {
            if (configuracion.hasOwnProperty(key) && key !== 'mail_config') {
                configuracion[key] = newConfig[key];
            }
        });

        // Manejar mail_config por separado si se envía
        if (newConfig.mail_config) {
            configuracion.mail_config = { ...configuracion.mail_config, ...newConfig.mail_config };
            configureMailer(); // Reconfigurar el mailer si la configuración de correo ha cambiado
        }

        // Manejar admin_email_for_reports específicamente para asegurar que sea un array
        if (newConfig.admin_email_for_reports !== undefined) {
            configuracion.admin_email_for_reports = Array.isArray(newConfig.admin_email_for_reports)
                                                      ? newConfig.admin_email_for_reports
                                                      : [newConfig.admin_email_for_reports].filter(Boolean); // Filtra valores falsy
        }


        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Configuración actualizada con éxito', configuracion: configuracion });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});


// Obtener estado de los números
app.get('/api/numeros', (req, res) => {
    res.json(numeros);
});

// Actualizar estado de los números (usado internamente o por admin)
app.post('/api/numeros', async (req, res) => {
    numeros = req.body; // Se espera el array completo de números
    try {
        await writeJsonFile(NUMEROS_FILE, numeros);
        res.json({ message: 'Números actualizados con éxito.' });
    } catch (error) {
        console.error('Error al actualizar números:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar números.' });
    }
});

// Ruta para obtener ventas (versión que usa await readJsonFile)
app.get('/api/ventas', async (req, res) => {
    try {
        const currentVentas = await readJsonFile(VENTAS_FILE);
        console.log('Enviando ventas al frontend:', currentVentas.length, 'ventas.');
        res.status(200).json(currentVentas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.', error: error.message });
    }
});


// Manejar solicitudes GET inesperadas a /api/compra
app.get('/api/compra', (req, res) => {
    res.status(404).json({
        message: 'Esta ruta no soporta solicitudes GET. Para realizar una una compra, utiliza el método POST en /api/comprar.',
        hint: 'Si estás intentando obtener información de ventas, usa la ruta GET /api/ventas.'
    });
});


// Ruta para la compra de tickets
app.post('/api/comprar', async (req, res) => {
    // Solo obtenemos los datos necesarios del body, pero la fecha del sorteo será la configurada en el backend.
    const { numerosSeleccionados, valorUsd, valorBs, metodoPago, referenciaPago, comprador, telefono, horaSorteo } = req.body; // 'fechaSorteo' se ignora de req.body para el drawDate

    if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !valorUsd || !valorBs || !metodoPago || !comprador || !telefono || !horaSorteo) {
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra (números, valor, método de pago, comprador, teléfono, hora del sorteo).' });
    }

    // Verificar si la página está bloqueada
    if (configuracion.pagina_bloqueada) {
        return res.status(403).json({ message: 'La página está bloqueada para nuevas compras en este momento.' });
    }

    try {
        // Cargar los números más recientes para evitar conflictos
        const currentNumeros = await readJsonFile(NUMEROS_FILE);

        // Verificar si los números ya están comprados
        const conflictos = numerosSeleccionados.filter(n =>
            currentNumeros.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (conflictos.length > 0) {
            return res.status(409).json({ message: `Los números ${conflictos.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        // Marcar los números como comprados
        numerosSeleccionados.forEach(numSel => {
            const numObj = currentNumeros.find(n => n.numero === numSel);
            if (numObj) {
                numObj.comprado = true;
            }
        });

        const now = moment().tz("America/Caracas");
        configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
        const numeroTicket = configuracion.ultimo_numero_ticket.toString().padStart(5, '0'); // Número de ticket correlativo de 5 dígitos

        const nuevaVenta = {
            id: Date.now(), // ID único para la venta
            purchaseDate: now.toISOString(), // Usar ISO string para consistencia
            drawDate: configuracion.fecha_sorteo, // *** CLAVE: Usar la fecha configurada en el backend ***
            drawTime: horaSorteo, // Hora del sorteo, que sí viene del cliente
            drawNumber: configuracion.numero_sorteo_correlativo, // Número correlativo del sorteo
            ticketNumber: numeroTicket,
            buyerName: comprador,
            buyerPhone: telefono,
            numbers: numerosSeleccionados,
            valueUSD: parseFloat(valorUsd),
            valueBs: parseFloat(valorBs),
            paymentMethod: metodoPago,
            paymentReference: referenciaPago,
            voucherURL: null, // Se llenará si se sube un comprobante
            validationStatus: 'Pendiente'
        };

        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);
        await writeJsonFile(NUMEROS_FILE, currentNumeros); // Guardar los números actualizados en el archivo
        numeros = currentNumeros; // Actualizar la variable global 'numeros' en memoria
        await writeJsonFile(CONFIG_FILE, configuracion); // Guardar el config con el nuevo número de ticket

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });

        // Enviar notificación a WhatsApp (al administrador)
        const whatsappMessage = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${configuracion.fecha_sorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;

        if (configuracion.admin_whatsapp_numbers && configuracion.admin_whatsapp_numbers.length > 0) {
            configuracion.admin_whatsapp_numbers.forEach(adminNumber => {
                const whatsappUrl = `https://api.whatsapp.com/send?phone=${adminNumber}&text=${whatsappMessage}`;
                console.log(`URL de WhatsApp para ${adminNumber}: ${whatsappUrl}`);
            });
        }

    } catch (error) {
        console.error('Error al procesar la compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});

// Subir comprobante de pago
app.post('/api/upload-comprobante/:ventaId', async (req, res) => {
    const ventaId = parseInt(req.params.ventaId);
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se subió ningún archivo.' });
    }

    const comprobanteFile = req.files.comprobante;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (!allowedTypes.includes(comprobanteFile.mimetype)) {
        return res.status(400).json({ message: 'Tipo de archivo no permitido. Solo se aceptan imágenes (JPG, PNG, GIF) y PDF.' });
    }

    const ventaIndex = ventas.findIndex(v => v.id === ventaId);
    if (ventaIndex === -1) {
        return res.status(404).json({ message: 'Venta no encontrada.' });
    }

    const now = moment().tz("America/Caracas");
    const timestamp = now.format('YYYYMMDD_HHmmss');
    const originalExtension = path.extname(comprobanteFile.name);
    const fileName = `comprobante_${ventaId}_${timestamp}${originalExtension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    try {
        await comprobanteFile.mv(filePath);

        ventas[ventaIndex].voucherURL = `/uploads/${fileName}`; // Guardar URL relativa para acceso
        await writeJsonFile(VENTAS_FILE, ventas);

        // Opcional: Registrar en un archivo de comprobantes si necesitas una lista separada
        comprobantes.push({
            id: Date.now(),
            venta_id: ventaId,
            comprobante_nombre: fileName,
            comprobante_tipo: comprobanteFile.mimetype,
            fecha_subida: now.format('YYYY-MM-DD HH:mm:ss'),
            url: `/uploads/${fileName}`
        });
        await writeJsonFile(COMPROBANTES_FILE, comprobantes);


        // Envío de correo electrónico con el comprobante adjunto
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const subject = `Nuevo Comprobante de Pago para Venta #${ventas[ventaIndex].ticketNumber}`;
            const htmlContent = `
                <p>Se ha subido un nuevo comprobante de pago para la venta con Ticket Nro. <strong>${ventas[ventaIndex].ticketNumber}</strong>.</p>
                <p><b>Comprador:</b> ${ventas[ventaIndex].buyerName}</p>
                <p><b>Teléfono:</b> ${ventas[ventaIndex].buyerPhone}</p>
                <p><b>Números:</b> ${ventas[ventaIndex].numbers.join(', ')}</p>
                <p><b>Monto USD:</b> $${ventas[ventaIndex].valueUSD.toFixed(2)}</p>
                <p><b>Monto Bs:</b> Bs ${ventas[ventaIndex].valueBs.toFixed(2)}</p>
                <p><b>Método de Pago:</b> ${ventas[ventaIndex].paymentMethod}</p>
                <p><b>Referencia:</b> ${ventas[ventaIndex].paymentReference}</p>
                <p>Haz clic <a href="${API_BASE_URL}/uploads/${fileName}" target="_blank">aquí</a> para ver el comprobante.</p>
                <p>También puedes verlo en el panel de administración.</p>
            `;
            const attachments = [
                {
                    filename: fileName,
                    path: filePath,
                    contentType: comprobanteFile.mimetype
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, subject, htmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo con el comprobante.');
            }
        }


        res.status(200).json({ message: 'Comprobante subido y asociado con éxito.', url: `/uploads/${fileName}` });
    } catch (error) {
        console.error('Error al subir el comprobante:', error);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.', error: error.message });
    }
});

// Servir archivos subidos estáticamente
app.use('/uploads', express.static(UPLOADS_DIR));


// Endpoint para obtener horarios de Zulia (y Chance)
app.get('/api/horarios-zulia', (req, res) => {
    res.json(horariosZulia);
});

// Endpoint para actualizar horarios de Zulia (y Chance)
app.post('/api/horarios', async (req, res) => {
    const { tipo, horarios } = req.body;
    if (!tipo || (tipo !== 'zulia' && tipo !== 'chance')) {
        return res.status(400).json({ message: 'Tipo de lotería inválido. Debe ser "zulia" o "chance".' });
    }
    if (!Array.isArray(horarios) || !horarios.every(h => typeof h === 'string')) {
        return res.status(400).json({ message: 'Formato de horarios inválido. Espera un array de strings.' });
    }
    try {
        horariosZulia[tipo] = horarios;
        await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        res.json({ message: `Horarios de ${tipo} actualizados con éxito.`, horarios: horariosZulia[tipo] });
    } catch (error) {
        console.error(`Error al actualizar horarios de ${tipo}:`, error);
        res.status(500).json({ message: `Error interno del servidor al actualizar horarios de ${tipo}.` });
    }
});

// Endpoint para obtener los resultados de Zulia por fecha
app.get('/api/resultados-zulia', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha) {
        return res.status(400).json({ message: 'Se requiere el parámetro "fecha" para consultar resultados de Zulia.' });
    }

    try {
        const allResultados = await readJsonFile(RESULTADOS_SORTEO_FILE);
        const resultsForDateAndZulia = allResultados.filter(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === 'zulia'
        );

        res.status(200).json(resultsForDateAndZulia);
    } catch (error) {
        console.error('Error al obtener resultados de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de Zulia.', error: error.message });
    }
});


// Endpoint para obtener los últimos resultados del sorteo
app.get('/api/resultados-sorteo', (req, res) => {
    res.json(resultadosSorteo);
});

// Endpoint para guardar/actualizar los resultados del sorteo
app.post('/api/resultados-sorteo', async (req, res) => {
    const { fecha, tipoLoteria, resultadosPorHora } = req.body;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid() || !tipoLoteria || !Array.isArray(resultadosPorHora)) {
        return res.status(400).json({ message: 'Faltan datos requeridos (fecha, tipoLoteria, resultadosPorHora) o el formato es inválido.' });
    }

    const now = moment().tz("America/Caracas");
    const currentDay = now.format('YYYY-MM-DD');

    try {
        let existingEntryIndex = resultadosSorteo.findIndex(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (existingEntryIndex !== -1) {
            resultadosSorteo[existingEntryIndex].resultados = resultadosPorHora;
            resultadosSorteo[existingEntryIndex].ultimaActualizacion = now.format('YYYY-MM-DD HH:mm:ss');
        } else {
            resultadosSorteo.push({
                fecha,
                tipoLoteria,
                resultados: resultadosPorHora,
                ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
            });
        }
        await writeJsonFile(RESULTADOS_SORTEO_FILE, resultadosSorteo);

        if (fecha === currentDay && tipoLoteria === 'zulia') {
            configuracion.ultima_fecha_resultados_zulia = fecha;
            await writeJsonFile(CONFIG_FILE, configuracion);
        }

        res.status(200).json({ message: 'Resultados de sorteo guardados/actualizados con éxito.', resultadosGuardados: resultadosSorteo });
    } catch (error) {
        console.error('Error al guardar/actualizar resultados de sorteo:', error);
        res.status(500).json({ message: 'Error interno del servidor al guardar/actualizar resultados de sorteo.', error: error.message });
    }
});


// Endpoint para el corte de ventas
app.post('/api/corte-ventas', async (req, res) => {
    try {
        const now = moment().tz("America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');

        const ventasDelDia = ventas.filter(venta =>
            moment(venta.purchaseDate).tz("America/Caracas").format('YYYY-MM-DD') === todayFormatted
        );

        const totalVentasUSD = ventasDelDia.reduce((sum, venta) => sum + venta.valueUSD, 0);
        const totalVentasBs = ventasDelDia.reduce((sum, venta) => sum + venta.valueBs, 0);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Corte de Ventas');

        worksheet.columns = [
            { header: 'Campo', key: 'field', width: 20 },
            { header: 'Valor', key: 'value', width: 30 }
        ];

        worksheet.addRow({ field: 'Fecha del Corte', value: now.format('YYYY-MM-DD HH:mm:ss') });
        worksheet.addRow({ field: 'Total Ventas USD', value: totalVentasUSD.toFixed(2) });
        worksheet.addRow({ field: 'Total Ventas Bs', value: totalVentasBs.toFixed(2) });
        worksheet.addRow({ field: 'Número de Ventas', value: ventasDelDia.length });

        worksheet.addRow({});
        worksheet.addRow({ field: 'Detalle de Ventas del Día' });
        worksheet.addRow({});

        const ventasHeaders = [
            { header: 'Fecha/Hora Compra', key: 'purchaseDate', width: 20 },
            { header: 'Fecha Sorteo', key: 'drawDate', width: 15 },
            { header: 'Hora Sorteo', key: 'drawTime', width: 15 }, // Añadido
            { header: 'Nro. Sorteo', key: 'drawNumber', width: 15 },
            { header: 'Nro. Ticket', key: 'ticketNumber', width: 15 },
            { header: 'Comprador', key: 'buyerName', width: 20 },
            { header: 'Teléfono', key: 'buyerPhone', width: 15 },
            { header: 'Números', key: 'numbers', width: 30 },
            { header: 'Valor USD', key: 'valueUSD', width: 15 },
            { header: 'Valor Bs', key: 'valueBs', width: 15 },
            { header: 'Método de Pago', key: 'paymentMethod', width: 20 },
            { header: 'Referencia Pago', key: 'paymentReference', width: 20 },
            { header: 'URL Comprobante', key: 'voucherURL', width: 30 },
            { header: 'Estado Validación', key: 'validationStatus', width: 20 }
        ];
        worksheet.addRow(ventasHeaders.map(h => h.header));

        ventasDelDia.forEach(venta => {
            worksheet.addRow({
                purchaseDate: moment(venta.purchaseDate).tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
                drawDate: venta.drawDate,
                drawTime: venta.drawTime || 'N/A', // Añadido
                drawNumber: venta.drawNumber,
                ticketNumber: venta.ticketNumber,
                buyerName: venta.buyerName,
                buyerPhone: venta.buyerPhone,
                numbers: venta.numbers.join(', '),
                valueUSD: venta.valueUSD,
                valueBs: venta.valueBs,
                paymentMethod: venta.paymentMethod,
                paymentReference: venta.paymentReference,
                voucherURL: venta.voucherURL ? `${API_BASE_URL}${venta.voucherURL}` : '',
                validationStatus: venta.validationStatus || 'Pendiente'
            });
        });

        const excelFileName = `Corte_Ventas_${todayFormatted}.xlsx`;
        const excelFilePath = path.join(REPORTS_DIR, excelFileName);
        await workbook.xlsx.writeFile(excelFilePath);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const subject = `Reporte de Corte de Ventas ${todayFormatted}`;
            const htmlContent = `
                <p>Se ha realizado el corte de ventas para el día <strong>${todayFormatted}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${totalVentasUSD.toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${totalVentasBs.toFixed(2)}</p>
                <p>Adjunto encontrarás el detalle completo en formato Excel.</p>
            `;
            const attachments = [
                {
                    filename: excelFileName,
                    path: excelFilePath,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, subject, htmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de corte de ventas.');
            }
        }

        numeros = numeros.map(n => ({ ...n, comprado: false }));
        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(VENTAS_FILE, ventas);

        res.status(200).json({ message: 'Corte de ventas realizado con éxito y números reiniciados. El historial de ventas se ha mantenido.' });

    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar corte de ventas.', error: error.message });
    }
});


// Tarea programada para reinicio diario de números y actualización de fecha de sorteo
cron.schedule('0 0 * * *', async () => {
    console.log('Ejecutando tarea programada: reinicio de números y actualización de fecha de sorteo...');
    try {
        const now = moment().tz("America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');
        const currentDrawDate = configuracion.fecha_sorteo;

        if (moment(currentDrawDate).isBefore(todayFormatted, 'day')) {
            console.log(`La fecha de sorteo (${currentDrawDate}) es anterior a hoy (${todayFormatted}). Reiniciando números y actualizando fecha.`);
            numeros = numeros.map(n => ({ ...n, comprado: false }));
            await writeJsonFile(NUMEROS_FILE, numeros);
            console.log('Números reiniciados a no comprados.');

            configuracion.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD');
            configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;
            configuracion.ultimo_numero_ticket = 0;
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${configuracion.fecha_sorteo} y correlativo a ${configuracion.numero_sorteo_correlativo}.`);
        } else {
                console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior o igual a hoy (${todayFormatted}).`);
        }
    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas"
});


// --- RUTAS PARA PREMIOS ---

// 1. GET /api/premios: Obtener premios por fecha
app.get('/api/premios', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Se requiere una fecha válida (YYYY-MM-DD) para obtener los premios.' });
    }

    const fechaFormateada = moment.tz(fecha, "America/Caracas").format('YYYY-MM-DD');

    try {
        const allPremios = await readJsonFile(PREMIOS_FILE);
        const premiosDelDia = allPremios[fechaFormateada] || {};

        const premiosParaFrontend = {
            sorteo12PM: premiosDelDia.sorteo12PM || { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo3PM: premiosDelDia.sorteo3PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' },
            sorteo5PM: premiosDelDia.sorteo5PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' }
        };

        res.status(200).json(premiosParaFrontend);

    } catch (error) {
        console.error('Error al obtener premios del archivo JSON:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener premios.', error: error.message });
    }
});

// 2. POST /api/premios: Guardar o actualizar premios
app.post('/api/premios', async (req, res) => {
    const { fechaSorteo, sorteo12PM, sorteo3PM, sorteo5PM } = req.body;

    if (!fechaSorteo || !moment(fechaSorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'La fecha del sorteo (YYYY-MM-DD) es requerida y debe ser válida para guardar premios.' });
    }

    const fechaFormateada = moment.tz(fechaSorteo, "America/Caracas").format('YYYY-MM-DD');

    try {
        const allPremios = await readJsonFile(PREMIOS_FILE);

        allPremios[fechaFormateada] = {
            sorteo12PM: sorteo12PM ? {
                tripleA: sorteo12PM.tripleA || '',
                tripleB: sorteo12PM.tripleB || '',
                valorTripleA: sorteo12PM.valorTripleA || '',
                valorTripleB: sorteo12PM.valorTripleB || ''
            } : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo3PM: sorteo3PM ? {
                tripleA: sorteo3PM.tripleA || '',
                tripleB: sorteo3PM.tripleB || '',
                valorTripleA: sorteo3PM.valorTripleA || '',
                valorTripleB: sorteo3PM.valorTripleB || ''
            } : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo5PM: sorteo5PM ? {
                tripleA: sorteo5PM.tripleA || '',
                tripleB: sorteo5PM.tripleB || '',
                valorTripleA: sorteo5PM.valorTripleA || '',
                valorTripleB: sorteo5PM.valorTripleB || ''
            } : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' }
        };

        await writeJsonFile(PREMIOS_FILE, allPremios);

        res.status(200).json({ message: 'Premios guardados/actualizados con éxito.', premiosGuardados: allPremios[fechaFormateada] });

    } catch (error) {
        console.error('Error al guardar premios en el archivo JSON:', error);
        res.status(500).json({ message: 'Error interno del servidor al guardar premios.', error: error.message });
    }
});

// Ruta POST para enviar un correo de prueba
app.post('/api/send-test-email', async (req, res) => {
    try {
        const { to, subject, html } = req.body;

        if (!to || !subject || !html) {
            return res.status(400).json({ message: 'Faltan parámetros: "to", "subject" y "html" son obligatorios.' });
        }

        const emailSent = await sendEmail(to, subject, html);

        if (emailSent) {
            res.status(200).json({ message: 'Correo de prueba enviado exitosamente.' });
        } else {
            res.status(500).json({ message: 'Fallo al enviar el correo de prueba. Revisa la configuración del mailer y los logs del servidor.' });
        }
    } catch (error) {
        console.error('Error en la ruta /api/send-test-email:', error);
        res.status(500).json({ message: 'Error interno del servidor al enviar correo de prueba.', error: error.message });
    }
});


// Endpoint para actualizar el estado de validación de una venta
app.put('/api/tickets/validate/:id', async (req, res) => {
    const ventaId = parseInt(req.params.id);
    const { validationStatus } = req.body;

    const estadosValidos = ['Confirmado', 'Falso', 'Pendiente'];
    if (!validationStatus || !estadosValidos.includes(validationStatus)) {
        return res.status(400).json({ message: 'Estado de validación inválido. Debe ser "Confirmado", "Falso" o "Pendiente".' });
    }

    try {
        const ventaIndex = ventas.findIndex(v => v.id === ventaId);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        const oldValidationStatus = ventas[ventaIndex].validationStatus;

        ventas[ventaIndex].validationStatus = validationStatus;

        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            const numerosAnulados = ventas[ventaIndex].numbers;
            if (numerosAnulados && numerosAnulados.length > 0) {
                let currentNumeros = await readJsonFile(NUMEROS_FILE);

                numerosAnulados.forEach(numAnulado => {
                    const numObj = currentNumeros.find(n => n.numero === numAnulado);
                    if (numObj) {
                        numObj.comprado = false;
                    }
                });
                await writeJsonFile(NUMEROS_FILE, currentNumeros);
                numeros = currentNumeros;
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} han sido puestos nuevamente disponibles.`);
            }
        }

        await writeJsonFile(VENTAS_FILE, ventas);

        res.status(200).json({ message: `Estado de la venta ${ventaId} actualizado a "${validationStatus}" con éxito.`, venta: ventas[ventaIndex] });
    } catch (error) {
        console.error(`Error al actualizar el estado de la venta ${ventaId}:`, error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el estado de la venta.', error: error.message });
    }
});


// Endpoint para exportar toda la base de datos en un archivo ZIP
app.get('/api/export-database', async (req, res) => {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    const archiveName = `rifas_db_backup_${moment().format('YYYYMMDD_HHmmss')}.zip`;

    res.attachment(archiveName);
    archive.pipe(res);

    try {
        for (const filePath of DATABASE_FILES) {
            const fileName = path.basename(filePath);
            try {
                await fs.access(filePath);
                archive.file(filePath, { name: fileName });
            } catch (fileError) {
                if (fileError.code === 'ENOENT') {
                    console.warn(`Archivo no encontrado, omitiendo: ${fileName}`);
                } else {
                    throw fileError;
                }
            }
        }
        archive.finalize();
        console.log('Base de datos exportada y enviada como ZIP.');
    } catch (error) {
        console.error('Error al exportar la base de datos:', error);
        res.status(500).send('Error al exportar la base de datos.');
    }
});

// Endpoint para generar el enlace de WhatsApp para un cliente (pago confirmado)
app.post('/api/generate-whatsapp-customer-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp.' });
    }

    try {
        const venta = ventas.find(v => v.id === ventaId);

        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp.' });
        }

        const customerPhoneNumber = venta.buyerPhone;
        const ticketNumber = venta.ticketNumber;
        const purchasedNumbers = venta.numbers.join(', ');
        const valorUsd = venta.valueUSD.toFixed(2);
        const valorBs = venta.valueBs.toFixed(2);
        const metodoPago = venta.paymentMethod;
        const referenciaPago = venta.paymentReference;
        const fechaCompra = moment(venta.purchaseDate).tz("America/Caracas").format('DD/MM/YYYY HH:mm');

        const whatsappMessage = encodeURIComponent(
            `¡Hola! 👋 Su compra ha sido *confirmada* con éxito. �\n\n` +
            `Detalles de su ticket:\n` +
            `*Número de Ticket:* ${ticketNumber}\n` +
            `*Números Jugados:* ${purchasedNumbers}\n` +
            `*Valor Pagado:* $${valorUsd} USD (Bs ${valorBs})\n` +
            `*Método de Pago:* ${metodoPago}\n` +
            (referenciaPago ? `*Referencia de Pago:* ${referenciaPago}\n` : '') +
            `*Fecha de Compra:* ${fechaCompra}\n\n` +
            `¡Mucha suerte en el sorteo! Estaremos informándole sobre los resultados.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${customerPhoneNumber}&text=${whatsappMessage}`;

        res.status(200).json({ whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para el cliente:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});

// Endpoint para generar el enlace de WhatsApp para notificar pago falso
app.post('/api/generate-whatsapp-false-payment-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp para pago falso.' });
    }

    try {
        const venta = ventas.find(v => v.id === ventaId);

        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp de pago falso.' });
        }

        const customerPhoneNumber = venta.buyerPhone;
        const ticketNumber = venta.ticketNumber;
        const comprador = venta.buyerName || 'Estimado cliente';

        const whatsappMessage = encodeURIComponent(
            `¡Hola ${comprador}! 👋\n\n` +
            `Lamentamos informarle que su pago para la compra con Ticket N° *${ticketNumber}* no pudo ser verificado.\n\n` +
            `Por lo tanto, su compra ha sido *anulada*.\n\n` +
            `Si cree que esto es un error o tiene alguna pregunta, por favor, contáctenos para aclarar la situación.\n\n` +
            `Gracias por su comprensión.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${customerPhoneNumber}&text=${whatsappMessage}`;

        res.status(200).json({ whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para pago falso:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp para pago falso.', error: error.message });
    }
});

// Endpoint NUEVO: Para enviar notificación de ticket ganador vía WhatsApp
app.post('/api/notify-winner', async (req, res) => {
    const {
        ventaId,
        buyerPhone,
        buyerName,
        numbers,
        drawDate,
        drawTime,
        ticketNumber,
        coincidentNumbers,
        totalPotentialPrizeBs,
        totalPotentialPrizeUSD
    } = req.body;

    if (!buyerPhone || !buyerName || !numbers || !drawDate || !drawTime || !ticketNumber || !coincidentNumbers || totalPotentialPrizeBs === undefined || totalPotentialPrizeUSD === undefined) {
        return res.status(400).json({ message: 'Faltan datos requeridos para enviar la notificación de ganador.' });
    }

    try {
        const formattedCoincidentNumbers = Array.isArray(coincidentNumbers) ? coincidentNumbers.join(', ') : coincidentNumbers;
        const formattedPurchasedNumbers = Array.isArray(numbers) ? numbers.join(', ') : numbers;

        const whatsappMessage = encodeURIComponent(
            `¡Felicidades, ${buyerName}! 🎉🎉🎉\n\n` +
            `¡Tu ticket ha sido *GANADOR* en el sorteo! 🥳\n\n` +
            `Detalles del Ticket:\n` +
            `*Nro. Ticket:* ${ticketNumber}\n` +
            `*Números Jugados:* ${formattedPurchasedNumbers}\n` +
            `*Fecha del Sorteo:* ${drawDate}\n` +
            `*Hora del Sorteo:* ${drawTime}\n` +
            `*Números Coincidentes:* ${formattedCoincidentNumbers}\n\n` +
            `*¡Has ganado!* 💰\n` +
            `*Premio Potencial:* $${parseFloat(totalPotentialPrizeUSD).toFixed(2)} USD (Bs ${parseFloat(totalPotentialPrizeBs).toFixed(2)})\n\n` +
            `Por favor, contáctanos para coordinar la entrega de tu premio.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${buyerPhone}&text=${whatsappMessage}`;

        // Aquí podrías agregar lógica para registrar el envío de la notificación
        console.log(`Generado enlace de WhatsApp para notificar a ${buyerName} (${buyerPhone}): ${whatsappLink}`);

        res.status(200).json({ message: 'Enlace de notificación de WhatsApp generado con éxito. Se intentará abrir WhatsApp.', whatsappLink: whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para notificar al ganador:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});


// POST /api/tickets/procesar-ganadores
app.post('/api/tickets/procesar-ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.body;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos para procesar ganadores.' });
    }

    try {
        const allVentas = await readJsonFile(VENTAS_FILE);
        const allResultadosSorteo = await readJsonFile(RESULTADOS_SORTEO_FILE);
        const allPremios = await readJsonFile(PREMIOS_FILE);

        const ticketsGanadoresParaEsteSorteo = [];

        const resultadosDelDia = allResultadosSorteo.find(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (!resultadosDelDia || !resultadosDelDia.resultados || resultadosDelDia.resultados.length === 0) {
            return res.status(200).json({ message: 'No se encontraron resultados de sorteo para esta fecha y lotería para procesar ganadores.' });
        }

        const premiosDelDia = allPremios[fecha];
        if (!premiosDelDia) {
            return res.status(200).json({ message: 'No se encontraron configuraciones de premios para esta fecha para procesar ganadores.' });
        }

        allVentas.forEach(venta => {
            if (venta.drawDate === fecha && venta.drawNumber.toString() === numeroSorteo.toString()) {
                let coincidentNumbers = [];
                let totalPotentialPrizeUSD = 0;
                let totalPotentialPrizeBs = 0;

                resultadosDelDia.resultados.forEach(r => {
                    const winningTripleA = r.tripleA ? r.tripleA.toString().padStart(3, '0') : null;
                    const winningTripleB = r.tripleB ? r.tripleB.toString().padStart(3, '0') : null;

                    let currentCoincidentNumbersForHour = [];

                    if (winningTripleA && venta.numbers.includes(winningTripleA)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleA, 10));
                    }
                    if (winningTripleB && venta.numbers.includes(winningTripleB)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleB, 10));
                    }

                    if (currentCoincidentNumbersForHour.length > 0) {
                        let prizeConfigForHour;
                        if (r.hora.includes('12:45 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo12PM;
                        } else if (r.hora.includes('04:45 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo3PM;
                        } else if (r.hora.includes('07:05 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo5PM;
                        }

                        if (prizeConfigForHour) {
                            if (currentCoincidentNumbersForHour.includes(parseInt(winningTripleA, 10)) && prizeConfigForHour.valorTripleA) {
                                totalPotentialPrizeUSD += parseFloat(prizeConfigForHour.valorTripleA);
                            }
                            if (currentCoincidentNumbersForHour.includes(parseInt(winningTripleB, 10)) && prizeConfigForHour.valorTripleB) {
                                totalPotentialPrizeUSD += parseFloat(prizeConfigForHour.valorTripleB);
                            }
                        }
                        coincidentNumbers = Array.from(new Set([...coincidentNumbers, ...currentCoincidentNumbersForHour]));
                    }
                });

                if (coincidentNumbers.length > 0) {
                    totalPotentialPrizeBs = totalPotentialPrizeUSD * configuracion.tasa_dolar;
                    ticketsGanadoresParaEsteSorteo.push({
                        ticketNumber: venta.ticketNumber,
                        buyerName: venta.buyerName,
                        buyerPhone: venta.buyerPhone,
                        numbers: venta.numbers,
                        drawDate: venta.drawDate,
                        drawNumber: venta.drawNumber,
                        purchaseDate: venta.purchaseDate,
                        coincidentNumbers: coincidentNumbers,
                        totalPotentialPrizeUSD: totalPotentialPrizeUSD,
                        totalPotentialPrizeBs: totalPotentialPrizeBs
                    });
                }
            }
        });

        const now = moment().tz("America/Caracas").toISOString();
        const newWinnersEntry = {
            drawDate: fecha,
            drawNumber: parseInt(numeroSorteo),
            lotteryType: tipoLoteria,
            winners: ticketsGanadoresParaEsteSorteo,
            processedAt: now
        };

        const existingEntryIndex = ganadoresSorteos.findIndex(entry =>
            entry.drawDate === fecha &&
            entry.drawNumber.toString() === numeroSorteo.toString() &&
            entry.lotteryType.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (existingEntryIndex !== -1) {
            ganadoresSorteos[existingEntryIndex] = newWinnersEntry;
            console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} actualizados.`);
        } else {
            ganadoresSorteos.push(newWinnersEntry);
            console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} añadidos.`);
        }

        await writeJsonFile(GANADORES_FILE, ganadoresSorteos);
        res.status(200).json({ message: 'Ganadores procesados y guardados con éxito.', totalGanadores: ticketsGanadoresParaEsteSorteo.length });

    } catch (error) {
        console.error('Error al procesar y guardar tickets ganadores:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar y guardar tickets ganadores.', error: error.message });
    }
});


// GET /api/tickets/ganadores
app.get('/api/tickets/ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.query;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos.' });
    }

    try {
        const foundEntry = ganadoresSorteos.find(entry =>
            entry.drawDate === fecha &&
            entry.drawNumber.toString() === numeroSorteo.toString() &&
            entry.lotteryType.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (foundEntry) {
            res.status(200).json({ ganadores: foundEntry.winners });
        } else {
            res.status(200).json({ ganadores: [], message: 'No se encontraron tickets ganadores procesados para esta consulta.' });
        }

    } catch (error) {
        console.error('Error al consultar tickets ganadores desde ganadores.json:', error);
        res.status(500).json({ message: 'Error interno del servidor al consultar tickets ganadores.', error: error.message });
    }
});


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        configureMailer();
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
        });
    });
});
�