// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors'); // Asegúrate de que este import está aquí
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone');
const archiver = require('archiver');
const admin = require('firebase-admin'); // <-- CAMBIO INTEGRADO: Agregado para Firebase Admin SDK
const { v4: uuidv4 } = require('uuid'); // Para generar IDs únicos
const crypto = require('crypto');
const { log } = require('console');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware para parsear JSON y archivos
app.use(express.json());
app.use(fileUpload());

// Constantes y configuraciones
const CARACAS_TIMEZONE = 'America/Caracas';
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// Rutas a tus archivos JSON (TODOS SE MANTIENEN)
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json'); // Usado para Zulia y Chance en el frontend
const VENTAS_FILE = path.join(__dirname, 'ventas.json'); // Todavía se usa para la lógica de archivo
const COMPROBANTES_FILE = path.join(__dirname, 'comprobantes.json');
const RESULTADOS_SORTEO_FILE = path.join(__dirname, 'resultados_sorteo.json'); // Archivo para guardar resultados del sorteo por hora/tipo
const PREMIOS_FILE = path.join(__dirname, 'premios.json'); // Precios de los premios por hora
const GANADORES_FILE = path.join(__dirname, 'ganadores.json'); // NUEVO: Archivo para guardar tickets ganadores procesados

// Lista de todos los archivos de la base de datos para exportar
const DATABASE_FILES = [
    CONFIG_FILE,
    NUMEROS_FILE,
    HORARIOS_ZULIA_FILE,
    VENTAS_FILE, // Todavía incluido para exportación de archivo local
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
                "block_reason_message": "", // NUEVO CAMPO: Razón por la que la página está bloqueada
                "mail_config": {
                    "host": "smtp.gmail.com",
                    "port": 465,
                    "secure": true, // Cambiado a true para 465
                    "user": process.env.EMAIL_USER || "tu_correo@gmail.com", // Usar variable de entorno o placeholder
                    "pass": process.env.EMAIL_PASS || "tu_contraseña_o_app_password",   // Usar variable de entorno o placeholder
                    "senderName": "Sistema de Rifas"
                },
                // INICIO CAMBIO: Agregar números de WhatsApp y configuración de umbral aquí
                "admin_whatsapp_numbers": ["584126083355", "584143630488", "584124723776"],
                "last_sales_notification_count": 0, // Nuevo: Contador para la última notificación de ventas por umbral
                "sales_notification_threshold": 20, // Nuevo: Umbral de ventas para enviar notificación (ej. cada 20 ventas)
                // FIN CAMBIO
                "admin_email_for_reports": ["tu_correo@gmail.com"], // Ahora es un array por defecto
                "ultima_fecha_resultados_zulia": null
            }),
            ensureJsonFile(NUMEROS_FILE, Array.from({ length: 1000 }, (_, i) => ({
                numero: i.toString().padStart(3, '0'),
                comprado: false,
                originalDrawNumber: null // Nuevo campo para el número de sorteo original de la compra
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
let ventas = []; // <-- Sigue siendo para el archivo local ventas.json
let comprobantes = [];
let resultadosSorteo = [];
let premios = {};
let ganadoresSorteos = []; // NUEVO: Variable global para almacenar los ganadores de los sorteos procesados

let db; // <-- CAMBIO INTEGRADO: Declara la variable para la instancia de Firestore

// --- CONSTANTES PARA LA LÓGICA DE CIERRE MANUAL DEL SORTEO ---
// Se eliminó la declaración duplicada de CARACAS_TIMEZONE
const SALES_THRESHOLD_PERCENTAGE = 80; // Porcentaje mínimo de ventas para no suspender (80%)
const DRAW_SUSPENSION_HOUR = 12; // Hora límite para la verificación (12 PM)
const DRAW_SUSPENSION_MINUTE = 15; // Minuto límite para la verificación (15 minutos, es decir, 12:15 PM)
const TOTAL_RAFFLE_NUMBERS = 1000;


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
    }  catch (error) {
        console.error('Error al enviar correo:', error);
        return false;
    }
}


// --- INICIO: Función para enviar notificaciones de ventas por WhatsApp (Resumen y Otros) ---
/**
 * Envía una notificación de resumen de ventas o mensajes personalizados por WhatsApp a los números de administrador configurados.
 * Esto genera una URL de wa.me y la imprime en consola, ya que el envío directo de WhatsApp requiere integración con una API externa.
 * @param {string} messageText - El texto del mensaje a enviar.
 */
async function sendWhatsappNotification(messageText) {
    try {
        const encodedMessage = encodeURIComponent(messageText);

        if (configuracion.admin_whatsapp_numbers && configuracion.admin_whatsapp_numbers.length > 0) {
            console.log(`\n--- Notificación de WhatsApp para Administradores ---`);
            configuracion.admin_whatsapp_numbers.forEach(adminNumber => {
                const whatsappUrl = `https://api.whatsapp.com/send?phone=${adminNumber}&text=${encodedMessage}`;
                console.log(`[WhatsApp Link for ${adminNumber}]: ${whatsappUrl}`);
            });
            console.log('--- Fin Notificación de WhatsApp ---\n');
            console.log('NOTA: Los enlaces de WhatsApp se han generado y mostrado en la consola. Para el envío automático real, se requiere una integración con un proveedor de WhatsApp API (ej. Twilio, Vonage, WhatsApp Business API).');
        } else {
            console.warn('No hay números de WhatsApp de administrador configurados para enviar notificaciones.');
        }

    } catch (error) {
        console.error('Error al enviar notificación por WhatsApp:', error);
    }
}

// Función auxiliar para enviar notificación de resumen de ventas (WhatsApp y Email)
async function sendSalesSummaryNotifications() {
    await loadInitialData(); // Asegura que la configuración y ventas estén al día
    const now = moment().tz(CARACAS_TIMEZONE);

    // Esta función seguirá leyendo de 'ventas' (el archivo local)
    const ventasParaFechaSorteo = ventas.filter(venta =>
        venta.drawDate === configuracion.fecha_sorteo && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
    );
    const totalVentas = ventasParaFechaSorteo.length;
    const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
    const soldPercentage = (totalVentas / totalPossibleTickets) * 100;


    // --- ENVIAR NOTIFICACIÓN POR WHATSAPP ---
    const whatsappMessageText = `*Actualización de Ventas Lotería:*\n\n` +
                                `Fecha Sorteo: *${configuracion.fecha_sorteo}*\n` +
                                `Sorteo Nro: *${configuracion.numero_sorteo_correlativo}*\n` +
                                `Total de Ventas Actuales (Confirmadas/Pendientes): *${totalVentas}* tickets vendidos.\n\n` +
                                `Porcentaje de Ventas: *${soldPercentage.toFixed(2)}%*\n\n` +
                                `Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}`;
    await sendWhatsappNotification(whatsappMessageText);


    // --- ENVIAR NOTIFICACIÓN POR CORREO ELECTRÓNICO CON EXCEL ---
    try {
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
                ventasParaFechaSorteo, // Pasa los datos de ventas detallados
                configuracion,
                'Reporte de Ventas Periódico',
                'Reporte_Ventas_Periodico'
            );

            const emailSubject = `Reporte de Ventas Periódico - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Se ha generado un reporte de ventas periódico para el sorteo del día <strong>${configuracion.fecha_sorteo}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${ventasParaFechaSorteo.reduce((sum, venta) => sum + venta.valueUSD, 0).toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${ventasParaFechaSorteo.reduce((sum, venta) => sum + venta.valueBs, 0).toFixed(2)}</p>
                <p><b>Porcentaje de Tickets Vendidos:</b> ${soldPercentage.toFixed(2)}%</p>
                <p>Adjunto encontrarás el detalle completo en formato Excel.</p>
                <p>Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
            `;
            const attachments = [
                {
                    filename: excelFileName,
                    path: excelFilePath,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de reporte de ventas periódico.');
            }
        }
    } catch (emailError) {
        console.error('Error al generar o enviar el reporte de ventas periódico por correo:', emailError);
    }
}


// --- FIN: Función para enviar notificaciones de ventas por WhatsApp (Resumen y Otros) ---


// Firebase Admin SDK Initialization
let serviceAccount;
try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountBase64) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    }
    const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    db = admin.firestore(); // <-- CAMBIO INTEGRADO: Inicializa la referencia a Firestore
    console.log('Firebase Admin SDK inicializado exitosamente.');
} catch (error) {
    console.error('Error al inicializar Firebase Admin SDK:', error);
    process.exit(1);
}


// --- CAMBIO INTEGRADO: Función para guardar en Firestore ---
/**
 * Guarda un documento de venta en la colección 'ventas_sorteo' de Firestore.
 * @param {object} ventaData - Los datos de la venta a guardar.
 */
async function guardarVentaEnFirestore(ventaData) {
    if (!db) {
        console.error('Error: Firestore no está inicializado.');
        return { success: false, message: 'Firestore no está inicializado.' };
    }
    
    try {
        // Usa `add` para que Firestore genere un ID único para el documento
        const docRef = await db.collection('ventas_sorteo').add(ventaData);
        console.log('DEBUG_BACKEND: Venta guardada en Cloud Firestore con ID:', docRef.id);
        return { success: true, docId: docRef.id };
    } catch (error) {
        console.error('Error al guardar la venta en Firestore:', error);
        throw new Error('Error al guardar la venta en la base de datos de Firebase.');
    }
}
// --- FIN CAMBIO INTEGRADO ---


// ===============================================
// === ENDPOINTS DE LA API =======================
// ===============================================

// NUEVA RUTA: Ruta raíz para verificar que el servidor está activo
app.get('/', (req, res) => {
    res.status(200).json({ message: 'Servidor de la API de Loterías activo. Accede a las rutas /api/ para interactuar.' });
});

// Configuración de CORS explícita y exclusiva para múltiples orígenes
// Este middleware DEBE ir ANTES de cualquier ruta.
app.use(cors({
    origin: ['https://paneladmin01.netlify.app', 'https://tuoportunidadeshoy.netlify.app'], // ¡AHORA INCLUYE AMBOS ORÍGENES!
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos HTTP que tu frontend usará
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeceras que tu frontend enviará
    credentials: true // Si tu frontend envía cookies o tokens de autorización
}));

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
            if (configuracion.hasOwnProperty(key) && key !== 'mail_config' && key !== 'block_reason_message') { // No permitir que el frontend actualice block_reason_message directamente
                configuracion[key] = newConfig[key];
            }
        });

        // Manejar admin_email_for_reports específicamente para asegurar que sea un array
        if (newConfig.admin_email_for_reports !== undefined) {
            configuracion.admin_email_for_reports = Array.isArray(newConfig.admin_email_for_reports)
                                                      ? newConfig.admin_email_for_reports
                                                      : [newConfig.admin_email_for_reports].filter(Boolean); // Filtra valores falsy
        }
        // Asegurar que admin_whatsapp_numbers sea un array
        if (newConfig.admin_whatsapp_numbers !== undefined) {
            configuracion.admin_whatsapp_numbers = Array.isArray(newConfig.admin_whatsapp_numbers)
                                                    ? newConfig.admin_whatsapp_numbers
                                                    : [newConfig.admin_whatsapp_numbers].filter(Boolean);
        }
        // Asegurar que last_sales_notification_count sea un número (puede venir como string de un input)
        if (newConfig.last_sales_notification_count !== undefined) {
            configuracion.last_sales_notification_count = parseInt(newConfig.last_sales_notification_count, 10);
        }
        // Asegurar que sales_notification_threshold sea un número
        if (newConfig.sales_notification_threshold !== undefined) {
            configuracion.sales_notification_threshold = parseInt(newConfig.sales_notification_threshold, 10);
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
    // DEBUG: Log para ver qué se envía cuando se solicita el estado de los números
    console.log('DEBUG_BACKEND: Recibida solicitud GET /api/numeros. Enviando estado actual de numeros.');
    res.json(numeros); // 'numeros' es la variable global que se mantiene en memoria
});

// Actualizar estado de los números (usado internamente o por admin)
app.post('/api/numeros', async (req, res) => {
    numeros = req.body; // Se espera el array completo de números
    try {
        await writeJsonFile(NUMEROS_FILE, numeros);
        console.log('DEBUG_BACKEND: Números actualizados y guardados en archivo.');
        res.json({ message: 'Números actualizados con éxito.' });
    } catch (error) {
        console.error('Error al actualizar números:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar números.' });
    }
});

// Ruta para obtener ventas (versión que usa await readJsonFile)
// NOTA: Esta ruta seguirá leyendo del archivo local ventas.json
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
    console.log('DEBUG_BACKEND: Recibida solicitud POST /api/comprar.');
    // Solo obtenemos los datos necesarios del body, pero la fecha del sorteo será la configurada en el backend.
    const { numerosSeleccionados, valorUsd, valorBs, metodoPago, referenciaPago, comprador, telefono, horaSorteo } = req.body; // 'fechaSorteo' se ignora de req.body para el drawDate

    if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !valorUsd || !valorBs || !metodoPago || !comprador || !telefono || !horaSorteo) {
        console.error('DEBUG_BACKEND: Faltan datos requeridos para la compra.');
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra (números, valor, método de pago, comprador, teléfono, hora del sorteo).' });
    }

    // Verificar si la página está bloqueada
    if (configuracion.pagina_bloqueada) {
        console.warn('DEBUG_BACKEND: Página bloqueada, denegando compra.');
        return res.status(403).json({ message: 'La página está bloqueada para nuevas compras en este momento.' });
    }

    try {
        // Cargar los números más recientes para evitar conflictos
        // Esto es CRÍTICO: Asegurarse de que `numeros` esté actualizado ANTES de modificarlo
        const currentNumeros = await readJsonFile(NUMEROS_FILE);
        console.log('DEBUG_BACKEND: Números actuales cargados desde archivo para verificar conflictos.');

        // Verificar si los números ya están comprados
        const conflictos = numerosSeleccionados.filter(n =>
            currentNumeros.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (conflictos.length > 0) {
            console.warn(`DEBUG_BACKEND: Conflicto de números: ${conflictos.join(', ')} ya comprados.`);
            return res.status(409).json({ message: `Los números ${conflictos.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        // Marcar los números como comprados
        numerosSeleccionados.forEach(numSel => {
            const numObj = currentNumeros.find(n => n.numero === numSel);
            if (numObj) {
                numObj.comprado = true;
                numObj.originalDrawNumber = configuracion.numero_sorteo_correlativo; // Guardar el correlativo del sorteo en que se compró
                console.log(`DEBUG_BACKEND: Número ${numSel} marcado como comprado.`);
            } else {
                console.warn(`DEBUG_BACKEND: Intento de marcar número no encontrado en la lista: ${numSel}`);
            }
        });

        // DEBUG: Imprimir el estado de los números seleccionados después de marcarlos como comprados
        console.log('DEBUG_BACKEND: Estado de números seleccionados después de marcarlos como comprados (en memoria antes de guardar):',
            currentNumeros.filter(n => numerosSeleccionados.includes(n.numero))
        );


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

        // --- CAMBIO INTEGRADO: Guardar en Firestore ---
        // Se mantiene la llamada a guardarVentaEnFirestore, pero recuerda que usa una colección de respaldo
        const firestoreSaveResult = await guardarVentaEnFirestore(nuevaVenta);
        if (!firestoreSaveResult.success) {
            console.warn('Fallo al guardar en Firestore (respaldo). Continuando con JSON local.');
            // No lanzar un error fatal aquí si no quieres que falle toda la compra por el respaldo
        }
        // --- FIN CAMBIO INTEGRADO ---
        
        // Mantener la lógica de guardado en el archivo JSON local para consistencia con otras partes que leen de allí
        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);
        console.log('DEBUG_BACKEND: Ventas guardadas en archivo local.');

        await writeJsonFile(NUMEROS_FILE, currentNumeros); // Guardar los números actualizados en el archivo
        numeros = currentNumeros; // Actualizar la variable global 'numeros' en memoria
        console.log('DEBUG_BACKEND: Números actualizados y guardados en archivo. Variable global "numeros" actualizada.');

        await writeJsonFile(CONFIG_FILE, configuracion); // Guardar el config con el nuevo número de ticket
        console.log('DEBUG_BACKEND: Configuración actualizada y guardada en archivo.');

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });
        console.log('DEBUG_BACKEND: Respuesta de compra enviada al frontend.');

        // Enviar notificación a WhatsApp (al administrador) de *compra individual*
        const whatsappMessageIndividual = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${configuracion.fecha_sorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;

        // Utilizar la nueva función sendWhatsappNotification
        await sendWhatsappNotification(whatsappMessageIndividual);
        console.log('DEBUG_BACKEND: Proceso de compra en backend finalizado.');

        // --- INICIO: Lógica para Notificación de Ventas por Umbral (Resumen) ---
        try {
            // Re-leer configuración y ventas para obtener los conteos más actualizados para la lógica
            const latestConfig = await readJsonFile(CONFIG_FILE);
            const latestVentas = await readJsonFile(VENTAS_FILE); // Lee del archivo local
            // Contar tickets confirmados o pendientes para la fecha del sorteo actual
            const currentTotalSales = latestVentas.filter(sale =>
                sale.drawDate === latestConfig.fecha_sorteo && (sale.validationStatus === 'Confirmado' || sale.validationStatus === 'Pendiente')
            ).length;

            const prevNotifiedCount = latestConfig.last_sales_notification_count || 0;
            const notificationThreshold = latestConfig.sales_notification_threshold || 20; // Por defecto 20

            // Determinar si se ha cruzado un nuevo múltiplo del umbral de notificación
            const currentMultiple = Math.floor(currentTotalSales / notificationThreshold);
            const prevMultiple = Math.floor(prevNotifiedCount / notificationThreshold);

            if (currentMultiple > prevMultiple) {
                console.log(`[WhatsApp Notificación Resumen] Ventas actuales (${currentTotalSales}) han cruzado un nuevo múltiplo (${currentMultiple * notificationThreshold}) del umbral (${notificationThreshold}). Enviando notificación de resumen.`);
                // Llama a la función que ahora maneja ambos tipos de notificaciones
                await sendSalesSummaryNotifications(); // Esta función ya carga los datos más recientes internamente

                // Actualizar el contador de la última notificación en la configuración
                latestConfig.last_sales_notification_count = currentMultiple * notificationThreshold; // Actualiza al múltiplo exacto
                await writeJsonFile(CONFIG_FILE, latestConfig);
                console.log(`[WhatsApp Notificación Resumen] Contador 'last_sales_notification_count' actualizado a ${latestConfig.last_sales_notification_count}`);
            } else {
                console.log(`[WhatsApp Notificación Resumen Check] Ventas actuales (${currentTotalSales}) no han cruzado un nuevo múltiplo del umbral (${notificationThreshold}). Último contador notificado: ${prevNotifiedCount}. No se envió notificación de resumen.`);
            }

        } catch (notificationError) {
            console.error('Error durante la verificación de notificación de ventas por umbral:', notificationError);
        }
        // --- FIN: Lógica para Notificación de Ventas por Umbral (Resumen) ---

    } catch (error) {
        console.error('ERROR_BACKEND: Error al procesar la compra:', error);
        // MODIFICACIÓN: Asegurar que la respuesta sea siempre un JSON válido en caso de error.
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

    // Busca en las ventas del archivo local (el endpoint /api/ventas sigue leyendo de aquí)
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

        // Actualiza la URL del voucher en la venta en memoria y en el archivo local
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
    }
    catch (error) {
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


/**
 * Genera un reporte de ventas en formato Excel y lo guarda en el directorio de reportes.
 * @param {Array} salesData - Array de objetos de ventas a incluir en el reporte.
 * @param {Object} config - Objeto de configuración actual (o relevante para el contexto del reporte).
 * @param {string} reportTitle - Título principal del reporte (ej., "Corte de Ventas", "Reporte de Suspensión").
 * @param {string} fileNamePrefix - Prefijo para el nombre del archivo (ej., "Corte_Ventas", "Reporte_Suspension").
 * @returns {Promise<{excelFilePath: string, excelFileName: string}>} Objeto con la ruta y el nombre del archivo Excel generado.
 */
async function generateGenericSalesExcelReport(salesData, config, reportTitle, fileNamePrefix) {
    const now = moment().tz(CARACAS_TIMEZONE);
    const todayFormatted = now.format('YYYY-MM-DD');

    const totalVentasUSD = salesData.reduce((sum, venta) => sum + venta.valueUSD, 0);
    const totalVentasBs = salesData.reduce((sum, venta) => sum + venta.valueBs, 0);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(reportTitle);

    worksheet.columns = [
        { header: 'Campo', key: 'field', width: 25 },
        { header: 'Valor', key: 'value', width: 40 }
    ];

    worksheet.addRow({ field: 'Título del Reporte', value: reportTitle });
    worksheet.addRow({ field: 'Fecha y Hora del Reporte', value: now.format('YYYY-MM-DD HH:mm:ss') });
    worksheet.addRow({ field: 'Fecha de Sorteo Reportado', value: config.fecha_sorteo || 'N/A' });
    // MODIFICACIÓN: Asegurar que el valor sea una cadena de texto
    worksheet.addRow({ field: 'Número de Sorteo Reportado', value: String(config.numero_sorteo_correlativo || 'N/A') });
    // MODIFICACIÓN: Asegurar que el valor sea una cadena de texto y que sea 0 si salesData es vacío
    worksheet.addRow({ field: 'Total de Tickets Vendidos', value: String(salesData.length || 0) });
    worksheet.addRow({ field: 'Total Vendido USD', value: totalVentasUSD.toFixed(2) });
    worksheet.addRow({ field: 'Total Vendido Bs', value: totalVentasBs.toFixed(2) });

    worksheet.addRow({}); // Espacio
    worksheet.addRow({ field: 'Detalle de Ventas' });
    worksheet.addRow({}); // Espacio

    const ventasHeaders = [
        { header: 'ID Interno Venta', key: 'id', width: 20 }, // Nuevo campo: ID interno de la venta
        { header: 'Fecha/Hora Compra', key: 'purchaseDate', width: 25 },
        { header: 'Fecha Sorteo', key: 'drawDate', width: 15 },
        { header: 'Hora Sorteo', key: 'drawTime', width: 15 },
        { header: 'Nro. Sorteo', key: 'drawNumber', width: 15 },
        { header: 'Nro. Ticket', key: 'ticketNumber', width: 15 },
        { header: 'Comprador', key: 'buyerName', width: 25 },
        { header: 'Teléfono', key: 'buyerPhone', width: 20 },
        { header: 'Números', key: 'numbers', width: 30 },
        { header: 'Valor USD', key: 'valueUSD', width: 15 },
        { header: 'Valor Bs', key: 'valueBs', width: 15 },
        { header: 'Método de Pago', key: 'paymentMethod', width: 20 },
        { header: 'Referencia Pago', key: 'paymentReference', width: 20 },
        { header: 'URL Comprobante', key: 'voucherURL', width: 35 },
        { header: 'Estado Validación', key: 'validationStatus', width: 25 },
        { header: 'Razón Anulación', key: 'voidedReason', width: 30 }, // Nuevo campo: Razón de anulación
        { header: 'Fecha Anulación', key: 'voidedAt', width: 25 },     // Nuevo campo: Fecha de anulación
        { header: 'Razón Cierre', key: 'closedReason', width: 30 },     // Nuevo campo: Razón de cierre
        { header: 'Fecha Cierre', key: 'closedAt', width: 25 }          // Nuevo campo: Fecha de cierre
    ];
    worksheet.addRow(ventasHeaders.map(h => h.header));

    salesData.forEach(venta => {
        worksheet.addRow({
            id: venta.id, // Mapeo del ID interno
            purchaseDate: moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss'),
            drawDate: venta.drawDate,
            drawTime: venta.drawTime || 'N/A',
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
            validationStatus: venta.validationStatus || 'Pendiente',
            voidedReason: venta.voidedReason || '', // Mapeo de razón de anulación
            voidedAt: venta.voidedAt ? moment(venta.voidedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '', // Mapeo de fecha de anulación
            closedReason: venta.closedReason || '', // Mapeo de razón de cierre
            closedAt: venta.closedAt ? moment(venta.closedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '' // Mapeo de fecha de cierre
        });
    });

    const excelFileName = `${fileNamePrefix}_${todayFormatted}_${now.format('HHmmss')}.xlsx`;
    const excelFilePath = path.join(REPORTS_DIR, excelFileName);
    await workbook.xlsx.writeFile(excelFilePath);

    return { excelFilePath, excelFileName };
}


// Endpoint para el Corte de Ventas (anteriormente corte-ventas, ahora con lógica de reseteo condicional)
app.post('/api/corte-ventas', async (req, res) => {
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const todayFormatted = now.format('YYYY-MM-DD');

        // Solo las ventas confirmadas o pendientes para la fecha del sorteo actual
        const ventasDelDia = ventas.filter(venta =>
            venta.drawDate === configuracion.fecha_sorteo && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );

        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            ventasDelDia,
            configuracion,
            'Corte de Ventas',
            'Corte_Ventas'
        );

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const totalVentasUSD = ventasDelDia.reduce((sum, venta) => sum + venta.valueUSD, 0);
            const totalVentasBs = ventasDelDia.reduce((sum, venta) => sum + venta.valueBs, 0);

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

        // --- INICIO DE LA NUEVA LÓGICA DE CORTE DE VENTAS Y RESETEO CONDICIONAL ---

        // Recargar configuración y horarios para asegurar que estén al día
        configuracion = await readJsonFile(CONFIG_FILE);
        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE);

        const fechaSorteoConfigurada = configuracion.fecha_sorteo;
        const zuliaTimes = horariosZulia.zulia; // Horarios del tipo 'zulia' (array de strings "HH:mm A")

        let ultimaHoraSorteo = null;
        if (Array.isArray(zuliaTimes) && zuliaTimes.length > 0) {
            // Encontrar la hora más tardía del día para Zulia
            ultimaHoraSorteo = zuliaTimes.reduce((latestTime, currentTimeStr) => {
                const latestMoment = moment.tz(`${fechaSorteoConfigurada} ${latestTime}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                const currentMoment = moment.tz(`${fechaSorteoConfigurada} ${currentTimeStr}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                return currentMoment.isAfter(latestMoment) ? currentTimeStr : latestTime;
            }, zuliaTimes[0]); // Se inicializa con el primer horario
        }

        const currentMomentInCaracas = moment().tz(CARACAS_TIMEZONE);
        const drawDateMoment = moment(fechaSorteoConfigurada, 'YYYY-MM-DD').tz(CARACAS_TIMEZONE);

        let shouldResetNumbers = false;
        let message = 'Corte de ventas realizado. Los números no han sido reseteados según la hora de sorteo y reservas.';

        if (ultimaHoraSorteo) {
            const ultimaHoraSorteoMoment = moment.tz(`${fechaSorteoConfigurada} ${ultimaHoraSorteo}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);

            // Condición para resetear números:
            // 1. Es el día del sorteo configurado Y ya ha pasado la última hora de sorteo de Zulia.
            // 2. O la fecha actual ya es posterior a la fecha del sorteo configurada (maneja casos de días siguientes).
            if ((currentMomentInCaracas.isSame(drawDateMoment, 'day') && currentMomentInCaracas.isSameOrAfter(ultimaHoraSorteoMoment)) ||
                currentMomentInCaracas.isAfter(drawDateMoment, 'day')) {
                
                shouldResetNumbers = true;
                message = 'Corte de ventas realizado. Números procesados y reseteados condicionalmente.';
            } else {
                console.log(`[Corte de Ventas] No se realizó el reseteo de números porque la última hora de sorteo de Zulia (${ultimaHoraSorteo}) aún no ha pasado para la fecha ${fechaSorteoConfigurada}, o la fecha actual es anterior al sorteo.`);
            }
        } else {
            console.warn('[Corte de Ventas] No se encontraron horarios de Zulia válidos para determinar la última hora. El reseteo de números por tiempo no se ejecutará.');
        }

        if (shouldResetNumbers) {
            // Los números que NO deben resetearse son aquellos que tienen una reserva activa.
            // Una reserva está activa si su originalDrawNumber es el sorteo actual O el siguiente sorteo.
            const currentDrawCorrelativo = parseInt(configuracion.numero_sorteo_correlativo);
            const nextDrawCorrelativo = currentDrawCorrelativo + 1;

            const updatedNumeros = numeros.map(num => {
                if (num.comprado && num.originalDrawNumber !== null) { // Solo si está comprado y tiene un sorteo original
                    const numOriginalDrawNumber = parseInt(num.originalDrawNumber);
                    // Si el número está reservado para el sorteo actual o el siguiente, NO lo reseteamos.
                    if (numOriginalDrawNumber === currentDrawCorrelativo || numOriginalDrawNumber === nextDrawCorrelativo) {
                        return num; // Mantener este número con su estado actual (comprado: true, originalDrawNumber)
                    }
                }
                // Si no tiene originalDrawNumber, o su reserva ya pasó (caducó), resetearlo.
                return {
                    ...num,
                    comprado: false,
                    originalDrawNumber: null
                };
            });

            numeros = updatedNumeros; // Actualizar la variable global en memoria
            await writeJsonFile(NUMEROS_FILE, numeros);
            console.log('Todos los números han sido procesados. Los no reservados han sido reiniciados a disponibles.');
        }

        // Se guarda el archivo de ventas nuevamente. Esto puede ser útil si hubo alguna modificación
        // en las ventas a través de la interfaz de administración que no se reflejó de inmediato en memoria.
        await writeJsonFile(VENTAS_FILE, ventas);

        res.status(200).json({ message: message });

    } catch (error) {
        console.error('Error al realizar Corte de Ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar Corte de Ventas.', error: error.message });
    }
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
            fechaSorteo: fechaFormateada, // AÑADIDO: Incluir la fecha del sorteo
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
// NOTA: Esta ruta seguirá actualizando el archivo local ventas.json
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

        // Si una venta se marca como "Falso", y antes no lo era, liberar los números asociados.
        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            const numerosAnulados = ventas[ventaIndex].numbers;
            if (numerosAnulados && numerosAnulados.length > 0) {
                let currentNumeros = await readJsonFile(NUMEROS_FILE);

                numerosAnulados.forEach(numAnulado => {
                    const numObj = currentNumeros.find(n => n.numero === numAnulado);
                    if (numObj) {
                        numObj.comprado = false; // El número vuelve a estar disponible globalmente
                        numObj.originalDrawNumber = null; // Limpiar el correlativo de sorteo original
                    }
                });
                await writeJsonFile(NUMEROS_FILE, currentNumeros);
                numeros = currentNumeros;
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} (marcada como Falsa) han sido puestos nuevamente disponibles.`);
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
        
        // <-- CAMBIO INTEGRADO: Añade un archivo Excel con los datos de ventas de Firestore
        const ventasSnapshot = await db.collection('ventas_sorteo').get();
        const ventasFirestore = ventasSnapshot.docs.map(doc => doc.data());
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas_Firestore');
        
        worksheet.columns = [
            { header: 'ID Interno Venta (Firestore)', key: 'id', width: 36 },
            { header: 'Números', key: 'numbers', width: 20 },
            { header: 'Cantidad', key: 'quantity', width: 10 },
            { header: 'Valor (Bs)', key: 'valueBs', width: 15 },
            { header: 'Valor ($)', key: 'valueUSD', width: 15 },
            { header: 'Comprador', key: 'buyerName', width: 30 },
            { header: 'Teléfono', key: 'buyerPhone', width: 20 },
            { header: 'Método de Pago', key: 'paymentMethod', width: 20 },
            { header: 'Referencia', key: 'paymentReference', width: 20 },
            { header: 'Fecha de Compra', key: 'purchaseDate', width: 25 },
            { header: 'Fecha Sorteo', key: 'drawDate', width: 15 },
            { header: 'Hora Sorteo', key: 'drawTime', width: 15 },
            { header: 'Nro. Sorteo', key: 'drawNumber', width: 15 },
            { header: 'Nro. Ticket', key: 'ticketNumber', width: 15 },
            { header: 'URL Comprobante', key: 'voucherURL', width: 35 },
            { header: 'Estado Validación', key: 'validationStatus', width: 25 },
        ];

        ventasFirestore.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                numbers: venta.numbers ? venta.numbers.join(', ') : '',
                quantity: venta.cantidad,
                valueBs: venta.valueBs,
                valueUSD: venta.valueUSD,
                buyerName: venta.buyerName,
                buyerPhone: venta.buyerPhone,
                paymentMethod: venta.paymentMethod,
                paymentReference: venta.paymentReference,
                purchaseDate: venta.purchaseDate,
                drawDate: venta.drawDate,
                drawTime: venta.drawTime,
                drawNumber: venta.drawNumber,
                ticketNumber: venta.ticketNumber,
                voucherURL: venta.voucherURL ? `${API_BASE_URL}${venta.voucherURL}` : '',
                validationStatus: venta.validationStatus,
            });
        });
        
        const excelBufferFirestore = await workbook.xlsx.writeBuffer();
        archive.append(excelBufferFirestore, { name: 'ventas_firestore_backup.xlsx' });
        // --- FIN CAMBIO INTEGRADO ---

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
        const venta = ventas.find(v => v.id === ventaId); // Lee del archivo local

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
        const fechaCompra = moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('DD/MM/YYYY HH:mm');

        const whatsappMessage = encodeURIComponent(
            `¡Hola! 👋 Su compra ha sido *confirmada* con éxito. \n\n` +
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
        const venta = ventas.find(v => v.id === ventaId); // Lee del archivo local

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
            `¡Felicidades, ${buyerName}! 🎉🥳🎉\n\n` + // Corregido: 🎉🥳🎉 para que no se muestre doble ?
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
        // Estas rutas siguen leyendo de los archivos JSON locales
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

        const now = moment().tz(CARACAS_TIMEZONE).toISOString();
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
        const foundEntry = ganadoresSorteos.find(entry => // Lee del archivo local
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

// Función para liberar números que ya excedieron la reserva de 2 sorteos
async function liberateOldReservedNumbers(currentDrawCorrelative, currentNumeros) {
    console.log(`[liberateOldReservedNumbers] Revisando números para liberar (correlativo actual: ${currentDrawCorrelativo})...`);
    let changed = false;
    currentNumeros.forEach(numObj => {
        // Un número está comprado y tiene un correlativo de sorteo original
        if (numObj.comprado && numObj.originalDrawNumber !== null) {
            // Si el correlativo actual es 2 o más que el correlativo original de compra
            // (ej: comprado para sorteo N, reservado para N y N+1. Se libera para sorteo N+2. Si actual es N+2 o más)
            if (currentDrawCorrelative >= (numObj.originalDrawNumber + 2)) {
                numObj.comprado = false;
                numObj.originalDrawNumber = null;
                changed = true;
                console.log(`Número ${numObj.numero} liberado. Comprado originalmente para sorteo ${numObj.originalDrawNumber}, ahora en sorteo ${currentDrawCorrelative}.`);
            }
        }
    });
    if (changed) {
        await writeJsonFile(NUMEROS_FILE, currentNumeros);
        numeros = currentNumeros; // Update global variable
        console.log('[liberateOldReservedNumbers] Números procesados y archivo guardado.');
    } else {
        console.log('[liberateOldReservedNumbers] No hay números antiguos para liberar en este momento.');
    }
}

// Función auxiliar para avanzar la configuración del sorteo (fecha, correlativo, último ticket)
async function advanceDrawConfiguration(currentConfig, targetDate) {
    currentConfig.fecha_sorteo = targetDate; // Set to the specific target date
    currentConfig.numero_sorteo_correlativo = (currentConfig.numero_sorteo_correlativo || 0) + 1;
    currentConfig.ultimo_numero_ticket = 0;
    currentConfig.pagina_bloqueada = false; // Desbloquear la página automáticamente al avanzar
    currentConfig.last_sales_notification_count = 0; // Resetear el contador de notificaciones de ventas
    currentConfig.block_reason_message = ""; // NUEVO: Limpiar la razón de bloqueo al avanzar el sorteo
    await writeJsonFile(CONFIG_FILE, currentConfig);
    console.log(`Configuración avanzada para el siguiente sorteo: Fecha ${currentConfig.fecha_sorteo}, Correlativo ${currentConfig.numero_sorteo_correlativo}.`);
}


/**
 * Evalúa el estado del sorteo actual basándose en el porcentaje de ventas
 * y actualiza el estado de los tickets, sin avanzar la fecha del sorteo.
 * @param {moment.Moment} nowMoment - El objeto moment actual para la hora de Caracas.
 * @returns {Promise<Object>} Resultado de la evaluación.
 */
async function evaluateDrawStatusOnly(nowMoment) {
    console.log(`[evaluateDrawStatusOnly] Iniciando evaluación de estado de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        // Cargar los datos más recientes para asegurar la precisión
        let currentConfig = await readJsonFile(CONFIG_FILE);
        let currentTickets = await readJsonFile(VENTAS_FILE); // Lee del archivo local

        const currentDrawDateStr = currentConfig.fecha_sorteo;

        // **CORRECCIÓN AQUÍ:** Filtrar las ventas para obtener los objetos de venta, no solo la longitud.
        const soldTicketsForCurrentDraw = currentTickets.filter(venta =>
            venta.drawDate === currentDrawDateStr && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );
        const totalSoldTicketsCount = soldTicketsForCurrentDraw.length;


        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalSoldTicketsCount / totalPossibleTickets) * 100;

        console.log(`[evaluateDrawStatusOnly] Tickets vendidos para el sorteo del ${currentDrawDateStr}: ${totalSoldTicketsCount}/${totalPossibleTickets} (${soldPercentage.toFixed(2)}%)`);

        let message = '';
        let whatsappMessageContent = '';
        let emailSubject = '';
        let emailHtmlContent = '';
        let updatedVentas = [...currentTickets]; // Crear una copia para modificar
        let excelReport = { excelFilePath: null, excelFileName: null };

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados.`);

            updatedVentas = currentTickets.map(venta => {
                // Marcar ventas confirmadas o pendientes para la fecha del sorteo actual como anuladas
                if (venta.drawDate === currentDrawDateStr && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')) {
                    return {
                        ...venta,
                        validationStatus: 'Anulado por bajo porcentaje', // Nuevo estado
                        voidedReason: 'Ventas insuficientes para el sorteo',
                        voidedAt: nowMoment.toISOString()
                    };
                }
                return venta;
            });
            message = `Sorteo del ${currentDrawDateStr} marcado como anulado por ventas insuficientes.`;
            whatsappMessageContent = `*¡Alerta de Sorteo Suspendido!* 🚨\n\nEl sorteo del *${currentDrawDateStr}* ha sido *ANULADO* debido a un bajo porcentaje de ventas (${soldPercentage.toFixed(2)}%).\n\nTodos los tickets válidos para este sorteo serán revalidados automáticamente para el próximo sorteo.`;
            emailSubject = `ALERTA: Sorteo Anulado - ${currentDrawDateStr}`;
            emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo del <strong>${currentDrawDateStr}</strong> ha sido <strong>ANULADO</strong>.</p>
                <p><b>Razón:</b> Bajo porcentaje de ventas (${soldPercentage.toFixed(2)}%).</p>
                <p>Adjunto encontrarás el reporte de ventas al momento de la suspensión.</p>
                <p>Todos los tickets válidos para este sorteo han sido marcados para ser revalidados automáticamente para el próximo sorteo.</p>
                <p>Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            // Establecer el mensaje de bloqueo para el cliente
            currentConfig.pagina_bloqueada = true;
            currentConfig.block_reason_message = "El sorteo ha sido ANULADO por bajo porcentaje de ventas. Tus tickets válidos han sido revalidados para el próximo sorteo. ¡Vuelve pronto!";

            // INICIO DEBUG LOGS PARA EL REPORTE
            console.log(`DEBUG_REPORTE: Fecha de Sorteo actual (currentDrawDateStr): ${currentDrawDateStr}`);
            console.log(`DEBUG_REPORTE: Tickets Confirmados/Pendientes para el sorteo actual (soldTicketsForCurrentDraw):`, soldTicketsForCurrentDraw);
            console.log(`DEBUG_REPORTE: Cantidad de tickets Confirmados/Pendientes: ${soldTicketsForCurrentDraw.length}`);
            console.log(`DEBUG_REPORTE: Número de sorteo correlativo de la configuración: ${currentConfig.numero_sorteo_correlativo}`);
            // FIN DEBUG LOGS PARA EL REPORTE
            // Generar Excel para el reporte de suspensión
            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw, // **PASANDO EL ARRAY DE OBJETOS DE VENTA**
                currentConfig,
                `Reporte de Suspensión del Sorteo ${currentDrawDateStr}`,
                'Reporte_Suspension'
            );

        } else {
            // Si las ventas son suficientes, el sorteo se cierra automáticamente para nuevas ventas.
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) cumplen o superan el ${SALES_THRESHOLD_PERCENTAGE}%. Marcando tickets como cerrados.`);

            updatedVentas = currentTickets.map(venta => {
                // Marcar ventas confirmadas o pendientes para la fecha del sorteo actual como cerradas por suficiencia de ventas
                if (venta.drawDate === currentDrawDateStr && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')) {
                    venta.validationStatus = 'Cerrado por Suficiencia de Ventas'; // Nuevo estado final para ventas de este sorteo
                    venta.closedReason = 'Ventas suficientes para el sorteo';
                    venta.closedAt = nowMoment.toISOString();
                }
                return venta;
            });
            message = `Sorteo del ${currentDrawDateStr} marcado como cerrado por suficiencia de ventas.`;
            whatsappMessageContent = `*¡Sorteo Cerrado Exitosamente!* ✅\n\nEl sorteo del *${currentDrawDateStr}* ha sido *CERRADO* con éxito. Se alcanzó el porcentaje de ventas (${soldPercentage.toFixed(2)}%) requerido.`;
            emailSubject = `NOTIFICACIÓN: Sorteo Cerrado Exitosamente - ${currentDrawDateStr}`;
            emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo del <strong>${currentDrawDateStr}</strong> ha sido <strong>CERRADO EXITOSAMENTE</strong>.</p>
                <p><b>Detalles:</b> Se alcanzó o superó el porcentaje de ventas requerido (${soldPercentage.toFixed(2)}%).</p>
                <p>Adjunto encontrarás el reporte de ventas al momento del cierre.</p>
                <p>La página de compra para este sorteo ha sido bloqueada. Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            // Establecer el mensaje de bloqueo para el cliente
            currentConfig.pagina_bloqueada = true;
            currentConfig.block_reason_message = "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!";

            // INICIO DEBUG LOGS PARA EL REPORTE
            console.log(`DEBUG_REPORTE: Fecha de Sorteo actual (currentDrawDateStr): ${currentDrawDateStr}`);
            console.log(`DEBUG_REPORTE: Tickets Confirmados/Pendientes para el sorteo actual (soldTicketsForCurrentDraw):`, soldTicketsForCurrentDraw);
            console.log(`DEBUG_REPORTE: Cantidad de tickets Confirmados/Pendientes: ${soldTicketsForCurrentDraw.length}`);
            console.log(`DEBUG_REPORTE: Número de sorteo correlativo de la configuración: ${currentConfig.numero_sorteo_correlativo}`);
            // FIN DEBUG LOGS PARA EL REPORTE
            // Generar Excel para el reporte de cierre
            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw, // **PASANDO EL ARRAY DE OBJETOS DE VENTA**
                currentConfig,
                `Reporte de Cierre del Sorteo ${currentDrawDateStr}`,
                'Reporte_Cierre'
            );
        }

        await writeJsonFile(VENTAS_FILE, updatedVentas);
        ventas = updatedVentas; // Actualiza la variable global en memoria
        console.log('[evaluateDrawStatusOnly] Estado de ventas actualizado.');

        // Enviar notificación de WhatsApp con el resultado de la evaluación
        await sendWhatsappNotification(whatsappMessageContent);

        // Enviar notificación por correo electrónico con adjunto Excel
        if (currentConfig.admin_email_for_reports && currentConfig.admin_email_for_reports.length > 0) {
            const attachments = excelReport.excelFilePath ? [{
                filename: excelReport.excelFileName,
                path: excelReport.excelFilePath,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }] : [];

            const emailSent = await sendEmail(currentConfig.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de suspensión/cierre.');
            }
        }

        // Bloquear la página (ya se hizo arriba) y guardar la configuración con el mensaje
        await writeJsonFile(CONFIG_FILE, currentConfig);
        console.log('[evaluateDrawStatusOnly] Página bloqueada para nuevas compras con mensaje actualizado.');

        return { success: true, message: message, evaluatedDate: currentDrawDateStr, salesPercentage: soldPercentage };

    } catch (error) {
        console.error('[evaluateDrawStatusOnly] ERROR durante la evaluación del sorteo:', error.stack || error.message);
        return { success: false, message: `Error interno al evaluar estado de sorteo: ${error.message}` };
    }
}


// --- Lógica central para la verificación, anulación/cierre y AVANCE del sorteo (Cierre Manual) ---
async function cerrarSorteoManualmente(nowMoment) {
    console.log(`[cerrarSorteoManualmente] Iniciando cierre manual de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        let currentConfig = await readJsonFile(CONFIG_FILE); // Usar let para permitir la modificación
        let currentNumeros = await readJsonFile(NUMEROS_FILE); // Cargar números para actualizar su estado
        
        const currentDrawDateStr = currentConfig.fecha_sorteo;
        const currentDrawCorrelativo = currentConfig.numero_sorteo_correlativo;

        // Step 1: Evaluate sales status (anular/cerrar sales)
        // This call to evaluateDrawStatusOnly will handle sending the WhatsApp and Email with Excel for the closure/suspension.
        const evaluationResult = await evaluateDrawStatusOnly(nowMoment);
        if (!evaluationResult.success) {
            return evaluationResult; // Propagar el error si la evaluación inicial falla
        }

        // Step 2: Liberate numbers based on the *current* draw correlative
        await liberateOldReservedNumbers(currentDrawCorrelativo, currentNumeros);


        // Step 3: Advance the configuration to the next day
        // Pass the new date as a formatted string
        const nextDayDate = nowMoment.clone().add(1, 'days').format('YYYY-MM-DD');
        await advanceDrawConfiguration(currentConfig, nextDayDate);

        // Re-leer la configuración para asegurar que los datos de la respuesta son los más recientes
        currentConfig = await readJsonFile(CONFIG_FILE); // Recargar config para el mensaje de WhatsApp/Email

        // Se envía una notificación de WhatsApp específica para el cierre manual
        // Note: The Excel report and basic email were already sent by evaluateDrawStatusOnly. This is an additional summary.
        const whatsappMessage = `*¡Sorteo Finalizado y Avanzado!* 🥳\n\nEl sorteo del *${evaluationResult.evaluatedDate}* ha sido finalizado. Ventas: *${evaluationResult.salesPercentage.toFixed(2)}%*.\n\nLa configuración ha avanzado al Sorteo Nro. *${currentConfig.numero_sorteo_correlativo}* para la fecha *${currentConfig.fecha_sorteo}*.`;
        await sendWhatsappNotification(whatsappMessage);

        // Si se desea un correo EXTRA de confirmación de AVANCE:
        if (currentConfig.admin_email_for_reports && currentConfig.admin_email_for_reports.length > 0) {
            const emailSubject = `CONFIRMACIÓN: Avance de Sorteo Manual - A Sorteo ${currentConfig.numero_sorteo_correlativo}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les confirma que se ha realizado el <strong>avance de sorteo manual</strong>.</p>
                <p><b>Sorteo Anterior:</b> Fecha ${evaluationResult.evaluatedDate}, Ventas ${evaluationResult.salesPercentage.toFixed(2)}%</p>
                <p><b>Nuevo Sorteo Activo:</b> Nro. <b>${currentConfig.numero_sorteo_correlativo}</b> para la fecha <b>${currentConfig.fecha_sorteo}</b>.</p>
                <p>La página de compra ha sido desbloqueada para nuevas ventas.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const emailSent = await sendEmail(currentConfig.admin_email_for_reports, emailSubject, emailHtmlContent);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de cierre manual y avance.');
            }
        }

        return {
            success: true,
            message: `${evaluationResult.message} y la configuración del sorteo ha avanzado para el siguiente.`,
            closedDate: evaluationResult.evaluatedDate,
            salesPercentage: evaluationResult.salesPercentage
        };

    } catch (error) {
        console.error('[cerrarSorteoManualmente] ERROR durante el cierre manual del sorteo:', error.stack || error.message);
        return { success: false, message: `Error interno: ${error.message}` };
    }
}


// --- ENDPOINT PARA CIERRE MANUAL DEL SORTEO (Full Close + Advance) ---
app.post('/api/cerrar-sorteo-manualmente', async (req, res) => {
    console.log('API: Recibida solicitud para cierre manual de sorteo.');
    try {
        // Cargar la configuración para obtener la fecha del sorteo actual
        await loadInitialData(); // Asegura que `configuracion`, `ventas` y `numeros` estén actualizadas en memoria
        const currentDrawDateStr = configuracion.fecha_sorteo;

        // Crear un objeto Moment que simule ser el día del sorteo pero después de la hora de corte.
        const simulatedMoment = moment().tz(CARACAS_TIMEZONE);
        const currentDrawDateMoment = moment.tz(currentDrawDateStr, CARACAS_TIMEZONE);

        // Si el sorteo es para hoy, simulamos 5 minutos después del corte para asegurar que se ejecute la lógica
        if (simulatedMoment.isSame(currentDrawDateMoment, 'day')) {
             simulatedMoment.set({ hour: DRAW_SUSPENSION_HOUR, minute: DRAW_SUSPENSION_MINUTE + 5, second: 0 });
        } else if (simulatedMoment.isBefore(currentDrawDateMoment, 'day')) {
             return res.status(400).json({ message: 'No se puede cerrar manualmente un sorteo cuya fecha aún no ha llegado.' });
        }
        // Si simulatedMoment ya es una fecha posterior a currentDrawDateMoment, la lógica de la función lo manejará.

        const result = await cerrarSorteoManualmente(simulatedMoment);

        if (result.success) {
            res.status(200).json({ message: result.message, closedDate: result.closedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de cierre manual de sorteo:', error.stack || error.message);
        res.status(500).json({ message: 'Error interno del servidor al cerrar el sorteo manualmente.', error: error.message });
    }
});


// --- ENDPOINT PARA SUSPENDER SORTEO (Evaluate Sales Only) ---
// Este endpoint permite evaluar las ventas y marcar los tickets, sin avanzar el sorteo.
app.post('/api/suspender-sorteo', async (req, res) => {
    console.log('API: Recibida solicitud para suspender sorteo (evaluación de ventas).');
    try {
        await loadInitialData(); // Carga los últimos datos
        const now = moment().tz(CARACAS_TIMEZONE);

        const result = await evaluateDrawStatusOnly(now); // Llama a la nueva función de solo evaluación

        if (result.success) {
            res.status(200).json({ message: result.message, evaluatedDate: result.evaluatedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de suspensión de sorteo:', error.stack || error.message);
        res.status(500).json({ message: 'Error interno del servidor al suspender sorteo.', error: error.message });
    }
});


// --- NUEVO ENDPOINT: Establecer fecha de sorteo manualmente (después de suspensión) ---
app.post('/api/set-manual-draw-date', async (req, res) => {
    const { newDrawDate } = req.body;
    console.log(`API: Recibida solicitud para establecer fecha de sorteo manualmente a: ${newDrawDate}.`);

    if (!newDrawDate || !moment(newDrawDate, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Fecha de sorteo inválida. Debe serYYYY-MM-DD.' });
    }

    try {
        let currentConfig = await readJsonFile(CONFIG_FILE);
        let currentNumeros = await readJsonFile(NUMEROS_FILE);
        let currentVentas = await readJsonFile(VENTAS_FILE); // Lee del archivo local
        
        // Guardamos la fecha y el correlativo anteriores para el mensaje de correo/WhatsApp
        const oldDrawDate = currentConfig.fecha_sorteo;
        const oldDrawCorrelativo = currentConfig.numero_sorteo_correlativo; 

        // 1. Avanzar la configuración a la fecha manualmente establecida
        await advanceDrawConfiguration(currentConfig, newDrawDate);
        // `currentConfig` ahora contiene el nuevo correlativo y fecha

        // 2. Liberar números reservados que ya no son válidos con el NUEVO correlativo.
        await liberateOldReservedNumbers(currentConfig.numero_sorteo_correlativo, currentNumeros);

        // Re-leer la configuración para asegurar que los datos de la respuesta son los más recientes
        currentConfig = await readJsonFile(CONFIG_FILE);

        // Filtrar ventas para el reporte Excel: Ventas del sorteo ANTERIOR que estaban confirmadas/pendientes.
        const salesForOldDraw = currentVentas.filter(venta =>
            venta.drawDate === oldDrawDate && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente' || venta.validationStatus === 'Cerrado por Suficiencia de Ventas' || venta.validationStatus === 'Anulado por bajo porcentaje')
        );

        // Generar Excel para el reporte de reprogramación
        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            salesForOldDraw,
            { fecha_sorteo: oldDrawDate, numero_sorteo_correlativo: oldDrawCorrelativo }, // Pass old config for report context
            `Reporte de Reprogramación del Sorteo ${oldDrawDate}`,
            'Reporte_Reprogramacion'
        );

        // Se envía la notificación de WhatsApp después de establecer la fecha manualmente
        const whatsappMessage = `*¡Sorteo Reprogramado!* 🗓️\n\nLa fecha del sorteo ha sido actualizada manualmente. Anteriormente Sorteo Nro. *${oldDrawCorrelativo}* de fecha *${oldDrawDate}*.\n\nAhora Sorteo Nro. *${currentConfig.numero_sorteo_correlativo}* para la fecha: *${newDrawDate}*.\n\n¡La página de compra está nuevamente activa!`;
        await sendWhatsappNotification(whatsappMessage);

        // Enviar notificación por correo electrónico para la reprogramación con adjunto Excel
        if (currentConfig.admin_email_for_reports && currentConfig.admin_email_for_reports.length > 0) {
            const emailSubject = `NOTIFICACIÓN: Sorteo Reprogramado - Nueva Fecha ${newDrawDate}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo ha sido <strong>reprogramado manualmente</strong>.</p>
                <p><b>Fecha Anterior:</b> ${oldDrawDate} (Sorteo Nro. ${oldDrawCorrelativo})</p>
                <p><b>Nueva Fecha:</b> ${newDrawDate} (Sorteo Nro. ${currentConfig.numero_sorteo_correlativo})</p>
                <p>Adjunto encontrarás el reporte de ventas del sorteo anterior (${oldDrawDate}) al momento de la reprogramación.</p>
                <p>La página de compra ha sido desbloqueada automáticamente.</p>
                <p>Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = excelFilePath ? [{
                filename: excelFileName,
                path: excelFilePath,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }] : [];

            const emailSent = await sendEmail(currentConfig.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de reprogramación.');
            }
        }

        res.status(200).json({
            success: true,
            message: `Fecha del sorteo actualizada manualmente a ${newDrawDate}. El número de sorteo ha avanzado al ${currentConfig.numero_sorteo_correlativo} y los números reservados antiguos han sido liberados.`,
            newConfig: currentConfig
        });

    } catch (error) {
        console.error('Error en la API de set-manual-draw-date:', error.stack || error.message);
        res.status(500).json({ message: 'Error interno del servidor al establecer la fecha del sorteo manualmente.', error: error.stack || error.message });
    }
});


// NUEVO ENDPOINT: Notificación de ventas para desarrolladores
app.post('/api/developer-sales-notification', async (req, res) => {
    console.log('API: Recibida solicitud para notificación de ventas para desarrolladores.');
    try {
        await loadInitialData(); // Asegura que la configuración y ventas estén al día
        const now = moment().tz(CARACAS_TIMEZONE);

        const currentDrawDateStr = configuracion.fecha_sorteo;
        const ventasParaFechaSorteo = ventas.filter(venta => // Lee del archivo local
            venta.drawDate === currentDrawDateStr && (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );
        const totalVentas = ventasParaFechaSorteo.length;
        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalVentas / totalPossibleTickets) * 100;

        let messageText = `*Notificación de Ventas para Desarrolladores*\n\n`;
        messageText += `*Hora de Notificación:* ${now.format('DD/MM/YYYY HH:mm:ss')}\n`;
        messageText += `*Fecha de Sorteo Activo:* ${currentDrawDateStr}\n`;
        messageText += `*Tickets Vendidos:* ${totalVentas} de ${totalPossibleTickets}\n`;
        messageText += `*Porcentaje de Ventas:* ${soldPercentage.toFixed(2)}%\n\n`;

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            messageText += `*Estado:* Las ventas están por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido.`;
        } else {
            messageText += `*Estado:* Las ventas han alcanzado o superado el ${SALES_THRESHOLD_PERCENTAGE}% requerido.`;
        }

        await sendWhatsappNotification(messageText);

        res.status(200).json({ message: 'Notificación de ventas para desarrolladores enviada exitosamente por WhatsApp.' });

    } catch (error) {
        console.error('Error al enviar notificación de ventas para desarrolladores:', error);
        res.status(500).json({ message: 'Error interno del servidor al enviar notificación de ventas para desarrolladores.', error: error.message });
    }
});


// Endpoint para limpiar todos los datos (útil para reinicios de sorteo)
app.post('/api/admin/limpiar-datos', async (req, res) => {
    try {
        // Limpia los datos en memoria y en archivos
        ventas = [];
        premios = {}; // Se cambia de [] a {} para que coincida con el formato de tu archivo
        horariosZulia = { zulia: ["12:00 PM", "04:00 PM", "07:00 PM"], chance: ["01:00 PM", "05:00 PM", "08:00 PM"] }; // Reiniciar como objeto
        // historialSorteos = []; // Esta variable no está declarada globalmente en el archivo provisto
        numeros = Array.from({ length: 1000 }, (_, i) => ({
            numero: String(i).padStart(3, '0'),
            comprado: false,
            originalDrawNumber: null // Se cambia a null para que coincida con la inicialización
        }));
        ganadoresSorteos = [];
        resultadosSorteo = [];
        comprobantes = [];


        await writeJsonFile(VENTAS_FILE, ventas); // Limpia el archivo local de ventas
        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(PREMIOS_FILE, premios);
        await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        await writeJsonFile(GANADORES_FILE, ganadoresSorteos); // Limpia el archivo local de ganadores
        await writeJsonFile(RESULTADOS_SORTEO_FILE, resultadosSorteo);
        await writeJsonFile(COMPROBANTES_FILE, comprobantes);


        // Reinicia la configuración en el JSON
        let currentConfig = await readJsonFile(CONFIG_FILE);
        await writeJsonFile(CONFIG_FILE, {
            "precio_ticket": 0.50,
            "tasa_dolar": 36.50, // Valor numérico por defecto
            "fecha_sorteo": moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD'),
            "numero_sorteo_correlativo": 1,
            "ultimo_numero_ticket": 0,
            "pagina_bloqueada": false,
            "block_reason_message": "",
            "mail_config": { // Mantener la configuración de correo
                "host": "smtp.gmail.com",
                "port": 465,
                "secure": true,
                "user": process.env.EMAIL_USER || "tu_correo@gmail.com",
                "pass": process.env.EMAIL_PASS || "tu_contraseña_o_app_password",
                "senderName": "Sistema de Rifas"
            },
            "admin_whatsapp_numbers": ["584126083355", "584143630488", "584124723776"], // Mantener números de WhatsApp
            "last_sales_notification_count": 0,
            "sales_notification_threshold": 20,
            "admin_email_for_reports": ["tu_correo@gmail.com"], // Mantener correos de admin
            "ultima_fecha_resultados_zulia": null
        });
        configuracion = await readJsonFile(CONFIG_FILE); // Recarga la configuración actualizada

        // <-- CAMBIO INTEGRADO: Limpia la colección de ventas de Firestore
        // Aunque no se usa para la lógica principal, se mantiene la limpieza por si es un respaldo
        if (db) {
            const ventasRef = db.collection('ventas_sorteo');
            const snapshot = await ventasRef.get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log('DEBUG_BACKEND: Colección de ventas de Firestore limpiada (respaldo).');
        } else {
            console.warn('Firestore no está inicializado, no se pudo limpiar la colección de ventas (respaldo).');
        }
        // --- FIN CAMBIO INTEGRADO ---

        res.status(200).json({ success: true, message: 'Todos los datos de ventas (JSON y respaldo Firestore), números y premios han sido limpiados.' });
    } catch (error) {
        console.error('Error al limpiar los datos:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al limpiar los datos.' });
    }
});


// Tareas programadas (Cron Jobs)
// ... (El resto de tus cron jobs y lógica permanece sin cambios) ...

// --- Tarea programada para verificación de sorteo (Cron Job Real) ---
// Se ejecuta cada día a las 12:15 PM (hora de Caracas)
cron.schedule('15 12 * * *', async () => {
    console.log('CRON JOB: Ejecutando tarea programada para verificar ventas y posible anulación/cierre de sorteo.');
    // Llama a la función cerrarSorteoManualmente con el momento actual real
    const cronResult = await cerrarSorteoManualmente(moment().tz(CARACAS_TIMEZONE));
    console.log(`CRON JOB Resultado: ${cronResult.message}`);
}, {
    timezone: CARACAS_TIMEZONE // Asegura que el cron se ejecuta en la zona horaria de Caracas
});
// --- FIN TAREA PROGRAMADA ---

// --- Tarea programada para Notificación de ventas por WhatsApp y Email (cada 55 minutos) ---
cron.schedule('*/55 * * * *', async () => { // Cambiado a cada 55 minutos
    console.log('CRON JOB: Ejecutando tarea programada para enviar notificación de resumen de ventas por WhatsApp y Email.');
    await sendSalesSummaryNotifications(); // Llama a la función que ahora envía ambos
});
// --- FIN TAREA PROGRAMADA ---


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        configureMailer(); // Asegura que el mailer se configure después de cargar la configuración
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);

        });
    });
}).catch(err => {
    console.error('Failed to initialize data and start server:', err);
    process.exit(1); // Sale del proceso si la carga inicial de datos falla
});
