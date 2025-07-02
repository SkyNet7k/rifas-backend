// server.js

// IMPORTANTE: Asegúrate de que las funciones `readFirestoreDoc` y `writeFirestoreDoc`
// en tu archivo `./adminUtils.js` sean funciones `async` y devuelvan Promesas.

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises; // Todavía necesario para directorios y archivos de reportes/comprobantes
const { readFileSync } = require('fs'); // Para leer archivos de configuración locales de forma síncrona
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone');
const archiver = require('archiver');
const admin = require('firebase-admin');
// Importar Firestore explícitamente
const { getFirestore } = require('firebase-admin/firestore');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { log } = require('console');

// Importar funciones de utilidad de administración
// handleLimpiarDatos ahora solo acepta primaryDb
const { handleLimpiarDatos } = require('./adminUtils');


dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware para parsear JSON y archivos
app.use(express.json());
app.use(fileUpload());

// Constantes y configuraciones
const CARACAS_TIMEZONE = 'America/Caracas';
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// Rutas a tus directorios locales
const UPLOADS_DIR = path.join(__dirname, 'uploads'); // Para comprobantes
const REPORTS_DIR = path.join(__dirname, 'reports'); // Para reportes Excel

// Rutas a los archivos JSON del usuario (que deben existir en el directorio raíz)
const USER_CONFIG_PATH = path.join(__dirname, 'configuracion.json');
const USER_HORARIOS_PATH = path.join(__dirname, 'horarios_zulia.json');
const USER_PREMIOS_PATH = path.join(__dirname, 'premios.json');


// --- Variables globales en memoria (caché de Firestore para datos pequeños y frecuentes) ---
let configuracion = {};
let numeros = []; // Caché de los 1000 números de la rifa (estado comprado/no comprado)
let horariosZulia = { zulia: [], chance: [] };
let premios = {}; // Caché para los premios

let primaryDb; // Instancia de Firestore para la base de datos principal

const SALES_THRESHOLD_PERCENTAGE = 80;
const DRAW_SUSPENSION_HOUR = 12;
const DRAW_SUSPENSION_MINUTE = 15;
const TOTAL_RAFFLE_NUMBERS = 1000;

// Firebase Admin SDK Initialization
let primaryServiceAccount;

try {
    const primaryServiceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!primaryServiceAccountBase64) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    }
    // MODIFICACIÓN: Reemplazar cualquier carácter de control no válido directamente
    // antes de decodificar y parsear el JSON.
    // Esto es más robusto para manejar casos donde los saltos de línea no están escapados como \\n
    // o hay otros caracteres de control inesperados.
    const cleanedPrimaryServiceAccountString = Buffer.from(primaryServiceAccountBase64, 'base64').toString('utf8');
    // Eliminar caracteres de control no válidos en JSON (excepto los que son parte de JSON como \n, \t)
    // Se usa una expresión regular para eliminar caracteres de control Unicode excepto los permitidos en JSON.
    // Los caracteres de control permitidos en JSON son U+0008 (BS), U+000C (FF), U+000A (LF), U+000D (CR), U+0009 (HT).
    // Otros caracteres de control (U+0000 a U+001F) deben ser escapados o eliminados.
    // Aquí, eliminamos los que no son los 5 permitidos.
    const finalServiceAccountString = cleanedPrimaryServiceAccountString.replace(/[\u0000-\u0007\u000B\u000E-\u001F]/g, '');

    primaryServiceAccount = JSON.parse(finalServiceAccountString);

    // Inicializa la aplicación Firebase
    const primaryApp = admin.initializeApp({
        credential: admin.credential.cert(primaryServiceAccount),
        databaseURL: `https://${primaryServiceAccount.project_id}.firebaseio.com`
    }, 'primary');
    
    // Obtén la instancia de Firestore desde la aplicación inicializada
    primaryDb = getFirestore(primaryApp);
    console.log('Firebase Admin SDK (Primary) inicializado exitosamente.');

} catch (error) {
    console.error('Error al inicializar Firebase Admin SDK (Primary):', error.message); // Log más específico
    process.exit(1); // Salir si no se puede inicializar la DB principal
}


// --- Funciones Auxiliares para Firestore (ahora solo aceptan la instancia de DB principal) ---

/**
 * Lee un documento específico de Firestore.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb).
 * @param {string} collectionName - El nombre de la colección.
 * @param {string} docId - El ID del documento.
 * @returns {Promise<object|null>} El objeto del documento si existe, o null.
 */
async function readFirestoreDoc(dbInstance, collectionName, docId) {
    if (!dbInstance) {
        console.warn(`readFirestoreDoc: dbInstance no está definida para leer ${collectionName}/${docId}.`);
        return null;
    }
    try {
        const docRef = dbInstance.collection(collectionName).doc(docId);
        const doc = await docRef.get();
        if (doc.exists) {
            return doc.data();
        } else {
            // Se usa ?.name para evitar errores si dbInstance.app es undefined
            console.log(`Documento ${docId} no encontrado en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}.`);
            return null;
        }
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error leyendo documento ${docId} en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error.message); // Log más específico
        throw error; // Re-lanzar el error para que sea manejado por el llamador
    }
}

/**
 * Escribe (establece o actualiza) un documento en Firestore.
 * Si el documento no existe, lo crea. Si existe, lo sobrescribe o fusiona.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb).
 * @param {string} collectionName - El nombre de la colección.
 * @param {string} docId - El ID del documento.
 * @param {object} data - Los datos a escribir.
 * @param {boolean} merge - Si es true, fusiona los datos con los existentes. Si es false, sobrescribe.
 * @returns {Promise<void>}
 */
async function writeFirestoreDoc(dbInstance, collectionName, docId, data, merge = true) {
    if (!dbInstance) {
        console.warn(`writeFirestoreDoc: dbInstance no está definida para escribir ${collectionName}/${docId}.`);
        return;
    }
    try {
        const docRef = dbInstance.collection(collectionName).doc(docId);
        await docRef.set(data, { merge });
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.log(`Documento ${docId} escrito/actualizado en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}.`);
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error escribiendo documento ${docId} en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error.message); // Log más específico
        throw error;
    }
}

/**
 * Añade un nuevo documento a una colección con un ID generado automáticamente.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb).
 * @param {string} collectionName - Nombre de la colección.
 * @param {Object} data - Los datos a añadir.
 * @returns {Promise<string|null>} El ID del nuevo documento o null en caso de error.
 */
async function addFirestoreDoc(dbInstance, collectionName, data) {
    if (!dbInstance) {
        console.warn(`addFirestoreDoc: dbInstance no está definida para añadir a ${collectionName}.`);
        return null;
    }
    try {
        const docRef = await dbInstance.collection(collectionName).add(data);
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.log(`Documento añadido a colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'} con ID: ${docRef.id}.`);
        return docRef.id;
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error añadiendo documento a colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error.message); // Log más específico
        throw error;
    }
}

/**
 * Elimina un documento de una colección.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb).
 * @param {string} collectionName - Nombre de la colección.
 * @param {string} docId - ID del documento a eliminar.
 * @returns {Promise<boolean>} True si la operación fue exitosa.
 */
async function deleteFirestoreDoc(dbInstance, collectionName, docId) {
    if (!dbInstance) {
        console.warn(`deleteFirestoreDoc: dbInstance no está definida para eliminar ${collectionName}/${docId}.`);
        return false;
    }
    try {
        await dbInstance.collection(collectionName).doc(docId).delete();
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.log(`Documento ${docId} eliminado de colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}.`);
        return true;
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error eliminando documento ${docId} de colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error.message); // Log más específico
        throw error;
    }
}

/**
 * Lee todos los documentos de una colección en Firestore.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb).
 * @param {string} collectionName - Nombre de la colección.
 * @returns {Promise<Array>} Un array de objetos de documentos.
 */
async function readFirestoreCollection(dbInstance, collectionName) {
    if (!dbInstance) {
        console.warn(`readFirestoreCollection: dbInstance no está definida para leer ${collectionName}.`);
        return [];
    }
    try {
        const snapshot = await dbInstance.collection(collectionName).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error leyendo colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error.message); // Log más específico
        return [];
    }
}

// Función para asegurar que los directorios existan (solo para archivos locales como comprobantes y reportes)
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        await fs.mkdir(REPORTS_DIR, { recursive: true });
        console.log('Directorios locales asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios locales:', error);
    }
}

// Carga inicial de datos (con respaldo local y sincronización con Firestore)
async function loadInitialData() {
    console.log('Iniciando carga inicial de datos...');

    // 1. Cargar configuración desde los archivos JSON del usuario (respaldo local)
    try {
        const userConfigContent = readFileSync(USER_CONFIG_PATH, 'utf8');
        configuracion = JSON.parse(userConfigContent);
        if (typeof configuracion.raffleNumbersInitialized === 'undefined') {
            configuracion.raffleNumbersInitialized = false;
        }
        if (Array.isArray(configuracion.tasa_dolar) || typeof configuracion.tasa_dolar !== 'number') {
            configuracion.tasa_dolar = 36.50;
            console.warn('tasa_dolar en configuracion.json no es un número válido o es un array. Se ha establecido un valor por defecto.');
        }
        if (!configuracion.fecha_sorteo || !moment(configuracion.fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
            configuracion.fecha_sorteo = moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD');
            console.warn('fecha_sorteo en configuracion.json no es una fecha válida. Se ha establecido una fecha por defecto.');
        }

        const userHorariosContent = readFileSync(USER_HORARIOS_PATH, 'utf8');
        const parsedHorarios = JSON.parse(userHorariosContent);
        if (Array.isArray(parsedHorarios)) {
            horariosZulia = { zulia: parsedHorarios, chance: [] };
        } else {
            horariosZulia = parsedHorarios;
        }
        if (!horariosZulia.zulia) horariosZulia.zulia = [];
        if (!horariosZulia.chance) horariosZulia.chance = [];

        premios = JSON.parse(readFileSync(USER_PREMIOS_PATH, 'utf8'));

        console.log('Datos iniciales cargados desde los archivos JSON del usuario.');
    } catch (err) {
        console.error('Error CRÍTICO al cargar los archivos JSON del usuario. Asegúrate de que existan y sean válidos:', err);
        process.exit(1);
    }

    // 2. Intentar sincronizar con Firestore (Primary)
    try {
        let configDoc = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (configDoc) {
            configuracion = { ...configuracion, ...configDoc };
            console.log('Configuración principal actualizada desde Firestore (Primary).');
        } else {
            console.warn('Documento de configuración "main_config" no encontrado en Firestore (Primary). Creando uno en Primary con los valores cargados localmente.');
            await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', configuracion);
        }

        let horariosDoc = await readFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance');
        if (horariosDoc) {
            horariosZulia = horariosDoc;
            console.log('Horarios de lotería actualizados desde Firestore (Primary).');
        } else {
            console.warn('Documento de horarios "zulia_chance" no encontrado en Firestore (Primary). Creando uno en Primary con los valores cargados localmente.');
            await writeFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance', horariosZulia);
        }

        let premiosDoc = await readFirestoreDoc(primaryDb, 'prizes', 'daily_prizes');
        if (premiosDoc) {
            premios = premiosDoc;
            console.log('Premios actualizados desde Firestore (Primary).');
        } else {
            console.warn('Documento de premios "daily_prizes" no encontrado en Firestore (Primary). Creando uno en Primary con los valores cargados localmente.');
            await writeFirestoreDoc(primaryDb, 'prizes', 'daily_prizes', premios);
        }

        // Inicializar colección de números de rifa si no ha sido inicializada (según el flag en la configuración)
        if (!configuracion.raffleNumbersInitialized) {
            console.warn('Flag "raffleNumbersInitialized" es false. Verificando e inicializando colección de números de rifa en Firestore (Primary).');
            const numerosSnapshot = await primaryDb.collection('raffle_numbers').get();
            if (numerosSnapshot.empty) {
                console.warn('Colección de números de rifa vacía en Primary. Inicializando con 1000 números por defecto.');
                const batch = primaryDb.batch();
                for (let i = 0; i < 1000; i++) {
                    const numStr = i.toString().padStart(3, '0');
                    const numRef = primaryDb.collection('raffle_numbers').doc(numStr);
                    batch.set(numRef, { numero: numStr, comprado: false, originalDrawNumber: null });
                }
                await batch.commit();
                await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', { raffleNumbersInitialized: true });
                configuracion.raffleNumbersInitialized = true;
                console.log('Colección de números de rifa inicializada y flag actualizado en Firestore (Primary).');
            } else {
                await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', { raffleNumbersInitialized: true });
                configuracion.raffleNumbersInitialized = true;
                console.log('Colección de números de rifa existente en Primary. Flag "raffleNumbersInitialized" actualizado a true en Firestore (Primary).');
            }
        } else {
            console.log('Colección de números de rifa ya inicializada (según flag en Primary). No se realiza inicialización masiva.');
        }

        console.log('Sincronización con Firestore (Primary) completada. El servidor usará los datos más recientes de Primary.');

    } catch (error) {
        console.error('Error al sincronizar datos con Firestore (Primary) durante la carga inicial. El servidor continuará operando con los datos cargados localmente:', error.message); // Log más específico
    }
}

// Configuración de Nodemailer
let transporter;
function configureMailer() {
    const emailUser = process.env.EMAIL_USER || configuracion.mail_config.user;
    const emailPass = process.env.EMAIL_PASS || configuracion.mail_config.pass;

    if (configuracion.mail_config && emailUser && emailPass) {
        transporter = nodemailer.createTransport({
            host: configuracion.mail_config.host,
            port: configuracion.mail_config.port,
            secure: configuracion.mail_config.secure,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });
        console.log('Nodemailer configurado.');
    } else {
        console.warn('Configuración de correo incompleta. El envío de correos no funcionará.');
        transporter = null;
    }
}

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
        const recipients = Array.isArray(to) ? to.join(',') : to;
        const mailOptions = {
            from: `${configuracion.mail_config.senderName || 'Sistema de Rifas'} <${configuracion.mail_config.user}>`,
            to: recipients,
            subject,
            html,
            attachments
        };
        await transporter.sendMail(mailOptions);
        console.log('Correo enviado exitosamente.');
        return true;
    }  catch (error) {
        console.error('Error al enviar correo:', error.message); // Log más específico
        return false;
    }
}

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
        console.error('Error al enviar notificación por WhatsApp:', error.message); // Log más específico
    }
}

// Función auxiliar para enviar notificación de resumen de ventas (WhatsApp y Email)
async function sendSalesSummaryNotifications() {
    // Para esta función de CRON, necesitamos la configuración y ventas más recientes.
    // Recargar configuración para asegurar que `last_sales_notification_count` y `sales_notification_threshold` estén al día.
    let latestConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
    if (latestConfig) {
        configuracion = latestConfig; // Actualizar caché global
    } else {
        console.error('No se pudo cargar la configuración de Firestore (Primary) para sendSalesSummaryNotifications. Usando valores en memoria.');
        // Continuar con la configuración en memoria si Firestore no está disponible
    }

    console.log('[sendSalesSummaryNotifications] Iniciando notificación de resumen de ventas.');
    const now = moment().tz(CARACAS_TIMEZONE);

    // Obtener ventas directamente de Firestore (Primary) para la fecha del sorteo actual
    const salesSnapshot = await primaryDb.collection('sales').where('drawDate', '==', configuracion.fecha_sorteo).get();
    const ventasParaFechaSorteo = salesSnapshot.docs
        .map(doc => doc.data())
        .filter(venta => venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente');

    const totalVentas = ventasParaFechaSorteo.length;
    const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
    const soldPercentage = (totalVentas / totalPossibleTickets) * 100;

    const whatsappMessageText = `*Actualización de Ventas Lotería:*\n\n` +
                                `Fecha Sorteo: *${configuracion.fecha_sorteo}*\n` +
                                `Sorteo Nro: *${configuracion.numero_sorteo_correlativo}*\n` +
                                `Total de Ventas Actuales (Confirmadas/Pendientes): *${totalVentas}* tickets vendidos.\n\n` +
                                `Porcentaje de Ventas: *${soldPercentage.toFixed(2)}%*\n\n` +
                                `Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}`;
    await sendWhatsappNotification(whatsappMessageText);

    try {
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
                ventasParaFechaSorteo,
                configuracion,
                'Reporte de Ventas Periódico',
                'Reporte_Ventas_Periodico'
            );

            const emailSubject = `Reporte de Ventas Periódico - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Se ha generado un reporte de ventas periódico para el sorteo del día <strong>${configuracion.fecha_sorteo}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${ventasParaFechaSorteo.reduce((sum, venta) => sum + (venta.valueUSD || 0), 0).toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${ventasParaFechaSorteo.reduce((sum, venta) => sum + (venta.valueBs || 0), 0).toFixed(2)}</p>
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
        console.error('Error al generar o enviar el reporte de ventas periódico por correo:', emailError.message); // Log más específico
    }
}


// ===============================================
// === ENDPOINTS DE LA API =======================
// ===============================================

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Servidor de la API de Loterías activo. Accede a las rutas /api/ para interactuar.' });
});

// Configuración de CORS explícita y exclusiva para múltiples orígenes
app.use(cors({
    origin: ['https://paneladmin01.netlify.app', 'https://tuoportunidadeshoy.netlify.app'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Obtener configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        // Siempre leer de la DB principal para GETs
        const configToRead = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (configToRead) {
            configuracion = configToRead; // Actualizar caché en memoria
        }
        const configToSend = { ...configuracion };
        delete configToSend.mail_config; // No enviar credenciales sensibles
        res.json(configToSend);
    } catch (error) {
        console.error('Error al obtener configuración de Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// Actualizar configuración (Cambiado de POST a PUT)
app.put('/api/configuracion', async (req, res) => {
    const newConfig = req.body;
    try {
        // Leer la configuración más reciente de Firestore (Primary) para asegurar consistencia
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            currentConfig = { ...configuracion };
            console.warn('Configuración no encontrada en Firestore (Primary) para actualizar. Usando la configuración en memoria como base.');
        }

        Object.keys(newConfig).forEach(key => {
            if (currentConfig.hasOwnProperty(key) && key !== 'mail_config' && key !== 'block_reason_message') {
                currentConfig[key] = newConfig[key];
            }
        });

        if (newConfig.admin_email_for_reports !== undefined) {
            currentConfig.admin_email_for_reports = Array.isArray(newConfig.admin_email_for_reports)
                                                      ? newConfig.admin_email_for_reports
                                                      : [newConfig.admin_email_for_reports].filter(Boolean);
        }
        if (newConfig.admin_whatsapp_numbers !== undefined) {
            currentConfig.admin_whatsapp_numbers = Array.isArray(newConfig.admin_whatsapp_numbers)
                                                    ? newConfig.admin_whatsapp_numbers
                                                    : [newConfig.admin_whatsapp_numbers].filter(Boolean);
        }
        if (newConfig.last_sales_notification_count !== undefined) {
            currentConfig.last_sales_notification_count = parseInt(newConfig.last_sales_notification_count, 10);
        }
        if (newConfig.sales_notification_threshold !== undefined) {
            currentConfig.sales_notification_threshold = parseInt(newConfig.sales_notification_threshold, 10);
        }

        // Escribir en la base de datos principal
        await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', currentConfig);
        configuracion = currentConfig; // Actualizar la caché en memoria

        res.json({ message: 'Configuración actualizada con éxito', configuracion: configuracion });
    } catch (error) {
        console.error('Error al actualizar configuración en Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});


// Obtener estado de los números (AHORA LEE DIRECTAMENTE DE FIRESTORE PRIMARY)
app.get('/api/numeros', async (req, res) => {
    try {
        const numbersSnapshot = await primaryDb.collection('raffle_numbers').get();
        const currentNumerosFirestore = numbersSnapshot.docs.map(doc => doc.data());
        console.log('DEBUG_BACKEND: Recibida solicitud GET /api/numeros. Enviando estado actual de numeros desde Firestore (Primary).');
        res.json(currentNumerosFirestore);
    } catch (error) {
        console.error('Error al obtener números desde Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener números.', error: error.message });
    }
});

// Actualizar estado de los números (usado internamente o por admin)
app.post('/api/numeros', async (req, res) => {
    const updatedNumbers = req.body;
    try {
        const primaryBatch = primaryDb.batch();
        updatedNumbers.forEach(num => {
            const numRef = primaryDb.collection('raffle_numbers').doc(num.numero);
            primaryBatch.set(numRef, num, { merge: true });
        });
        await primaryBatch.commit();
        numeros = updatedNumbers; // Actualizar caché en memoria

        console.log('DEBUG_BACKEND: Números actualizados en Firestore (Primary) y en caché (solo los comprados).');
        res.json({ message: 'Números actualizados con éxito.' });
    } catch (error) {
        console.error('Error al actualizar números en Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al actualizar números.' });
    }
});

// Ruta para obtener ventas (ahora siempre desde Firestore Primary)
app.get('/api/ventas', async (req, res) => {
    try {
        const currentVentas = await readFirestoreCollection(primaryDb, 'sales');
        console.log('Enviando ventas al frontend desde Firestore (Primary):', currentVentas.length, 'ventas.');
        res.status(200).json(currentVentas);
    } catch (error) {
        console.error('Error al obtener ventas desde Firestore (Primary):', error.message); // Log más específico
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
    const { numerosSeleccionados, valorUsd, valorBs, metodoPago, referenciaPago, comprador, telefono, horaSorteo } = req.body;

    if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !valorUsd || !valorBs || !metodoPago || !comprador || !telefono || !horaSorteo) {
        console.error('DEBUG_BACKEND: Faltan datos requeridos para la compra.');
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra (números, valor, método de pago, comprador, teléfono, hora del sorteo).' });
    }

    let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
    if (!currentConfig) {
        console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para la compra. Usando la configuración en memoria.');
    } else {
        configuracion = currentConfig;
    }

    if (configuracion.pagina_bloqueada) {
        console.warn('DEBUG_BACKEND: Página bloqueada, denegando compra.');
        return res.status(403).json({ message: 'La página está bloqueada para nuevas compras en este momento.' });
    }

    try {
        const selectedNumbersSnapshot = await primaryDb.collection('raffle_numbers')
                                            .where('numero', 'in', numerosSeleccionados)
                                            .get();
        const currentSelectedNumbersFirestore = selectedNumbersSnapshot.docs.map(doc => doc.data());

        const conflictos = numerosSeleccionados.filter(n =>
            currentSelectedNumbersFirestore.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (conflictos.length > 0) {
            console.warn(`DEBUG_BACKEND: Conflicto de números: ${conflictos.join(', ')} ya comprados.`);
            return res.status(409).json({ message: `Los números ${conflictos.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        const primaryBatch = primaryDb.batch();
        numerosSeleccionados.forEach(numSel => {
            const numRef = primaryDb.collection('raffle_numbers').doc(numSel);
            primaryBatch.update(numRef, {
                comprado: true,
                originalDrawNumber: configuracion.numero_sorteo_correlativo
            });
            const numObjInCache = numeros.find(n => n.numero === numSel);
            if (numObjInCache) {
                numObjInCache.comprado = true;
                numObjInCache.originalDrawNumber = configuracion.numero_sorteo_correlativo;
            } else {
                numeros.push({ numero: numSel, comprado: true, originalDrawNumber: configuracion.numero_sorteo_correlativo });
            }
        });
        await primaryBatch.commit();
        console.log('DEBUG_BACKEND: Números actualizados en Firestore (Primary) y en caché (solo los comprados).');

        const now = moment().tz("America/Caracas");
        configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
        const numeroTicket = configuracion.ultimo_numero_ticket.toString().padStart(5, '0');

        const nuevaVenta = {
            id: Date.now(),
            purchaseDate: now.toISOString(),
            drawDate: configuracion.fecha_sorteo,
            drawTime: horaSorteo,
            drawNumber: configuracion.numero_sorteo_correlativo,
            ticketNumber: numeroTicket,
            buyerName: comprador,
            buyerPhone: telefono,
            numbers: numerosSeleccionados,
            valueUSD: parseFloat(valorUsd),
            valueBs: parseFloat(valorBs),
            paymentMethod: metodoPago,
            paymentReference: referenciaPago,
            voucherURL: null,
            validationStatus: 'Pendiente'
        };

        const docRef = await primaryDb.collection('sales').add(nuevaVenta);
        nuevaVenta.firestoreId = docRef.id;
        console.log('DEBUG_BACKEND: Venta guardada en Firestore (Primary) con ID:', docRef.id);

        await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', {
            ultimo_numero_ticket: configuracion.ultimo_numero_ticket
        });
        console.log('DEBUG_BACKEND: Configuración (ultimo_numero_ticket) actualizada en Firestore (Primary).');

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });
        console.log('DEBUG_BACKEND: Respuesta de compra enviada al frontend.');

        const whatsappMessageIndividual = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${configuracion.fecha_sorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;
        await sendWhatsappNotification(whatsappMessageIndividual);
        console.log('DEBUG_BACKEND: Proceso de compra en backend finalizado.');

        try {
            let latestConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
            if (latestConfig) {
                configuracion = latestConfig;
            } else {
                console.warn('No se pudo cargar la última configuración de Firestore (Primary) para la lógica de notificación por umbral. Usando la configuración en memoria.');
            }

            const salesSnapshot = await primaryDb.collection('sales').where('drawDate', '==', configuracion.fecha_sorteo).get();
            const currentTotalSales = salesSnapshot.docs
                .map(doc => doc.data())
                .filter(sale => sale.validationStatus === 'Confirmado' || sale.validationStatus === 'Pendiente')
                .length;

            const prevNotifiedCount = configuracion.last_sales_notification_count || 0;
            const notificationThreshold = configuracion.sales_notification_threshold || 20;

            const currentMultiple = Math.floor(currentTotalSales / notificationThreshold);
            const prevMultiple = Math.floor(prevNotifiedCount / notificationThreshold);

            if (currentMultiple > prevMultiple) {
                console.log(`[WhatsApp Notificación Resumen] Ventas actuales (${currentTotalSales}) han cruzado un nuevo múltiplo (${currentMultiple * notificationThreshold}) del umbral (${notificationThreshold}). Enviando notificación de resumen.`);
                await sendSalesSummaryNotifications();

                // Actualizar en la DB principal
                await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', {
                    last_sales_notification_count: currentMultiple * notificationThreshold
                });
                console.log(`[WhatsApp Notificación Resumen] Contador 'last_sales_notification_count' actualizado a ${currentMultiple * notificationThreshold} en Firestore (Primary).`);
            } else {
                console.log(`[WhatsApp Notificación Resumen Check] Ventas actuales (${currentTotalSales}) no han cruzado un nuevo múltiplo del umbral (${notificationThreshold}). Último contador notificado: ${prevNotifiedCount}. No se envió notificación de resumen.`);
            }

        } catch (notificationError) {
            console.error('Error durante la verificación de notificación de ventas por umbral:', notificationError.message); // Log más específico
        }

    } catch (error) {
        console.error('ERROR_BACKEND: Error al procesar la compra:', error.message); // Log más específico
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

    const salesSnapshot = await primaryDb.collection('sales').where('id', '==', ventaId).limit(1).get();
    if (salesSnapshot.empty) {
        return res.status(404).json({ message: 'Venta no encontrada.' });
    }
    const ventaDoc = salesSnapshot.docs[0];
    const ventaData = ventaDoc.data();
    const firestoreVentaId = ventaDoc.id;

    const now = moment().tz("America/Caracas");
    const timestamp = now.format('YYYYMMDD_HHmmss');
    const originalExtension = path.extname(comprobanteFile.name);
    const fileName = `comprobante_${ventaId}_${timestamp}${originalExtension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    try {
        await comprobanteFile.mv(filePath);

        // Actualizar en la base de datos principal
        await writeFirestoreDoc(primaryDb, 'sales', firestoreVentaId, { voucherURL: `/uploads/${fileName}` });
        console.log(`Voucher URL actualizado en Firestore (Primary) para venta ${firestoreVentaId}.`);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const subject = `Nuevo Comprobante de Pago para Venta #${ventaData.ticketNumber}`;
            const htmlContent = `
                <p>Se ha subido un nuevo comprobante de pago para la venta con Ticket Nro. <strong>${ventaData.ticketNumber}</strong>.</p>
                <p><b>Comprador:</b> ${ventaData.buyerName}</p>
                <p><b>Teléfono:</b> ${ventaData.buyerPhone}</p>
                <p><b>Números:</b> ${ventaData.numbers.join(', ')}</p>
                <p><b>Monto USD:</b> $${ventaData.valueUSD.toFixed(2)}</p>
                <p><b>Monto Bs:</b> Bs ${ventaData.valueBs.toFixed(2)}</p>
                <p><b>Método de Pago:</b> ${ventaData.paymentMethod}</p>
                <p><b>Referencia:</b> ${ventaData.paymentReference}</p>
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
        console.error('Error al subir el comprobante:', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.', error: error.message });
    }
});

// Servir archivos subidos estáticamente
app.use('/uploads', express.static(UPLOADS_DIR));


// Endpoint para obtener horarios de Zulia (y Chance)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        // Siempre leer de la DB principal
        const horarios = await readFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance');
        if (horarios) {
            horariosZulia = horarios; // Actualizar caché
        }
        res.json(horariosZulia);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia de Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
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
        let currentHorarios = await readFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance');
        if (!currentHorarios) currentHorarios = { zulia: [], chance: [] };
        currentHorarios[tipo] = horarios;

        // Escribir en la base de datos principal
        await writeFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance', currentHorarios);
        horariosZulia = currentHorarios; // Actualizar caché

        res.json({ message: `Horarios de ${tipo} actualizados con éxito.`, horarios: horariosZulia[tipo] });
    } catch (error) {
        console.error(`Error al actualizar horarios de ${tipo} en Firestore (Primary):`, error.message); // Log más específico
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
        const resultsSnapshot = await primaryDb.collection('draw_results')
                                      .where('fecha', '==', fecha)
                                      .where('tipoLoteria', '==', 'zulia')
                                      .get();
        const resultsForDateAndZulia = resultsSnapshot.docs.map(doc => doc.data());

        res.status(200).json(resultsForDateAndZulia);
    }
    catch (error) {
        console.error('Error al obtener resultados de Zulia desde Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de Zulia.', error: error.message });
    }
});


// Endpoint para obtener los últimos resultados del sorteo (ahora siempre desde Firestore Primary)
app.get('/api/resultados-sorteo', async (req, res) => {
    try {
        const currentResultados = await readFirestoreCollection(primaryDb, 'draw_results');
        console.log('Enviando resultados de sorteo al frontend desde Firestore (Primary):', currentResultados.length, 'resultados.');
        res.status(200).json(currentResultados);
    } catch (error) {
        console.error('Error al obtener resultados de sorteo desde Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de sorteo.', error: error.message });
    }
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
        const existingResultsSnapshot = await primaryDb.collection('draw_results')
                                                .where('fecha', '==', fecha)
                                                .where('tipoLoteria', '==', tipoLoteria)
                                                .limit(1)
                                                .get();

        let docId;
        const dataToSave = {
            fecha,
            tipoLoteria,
            resultados: resultadosPorHora,
            ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
        };

        if (!existingResultsSnapshot.empty) {
            docId = existingResultsSnapshot.docs[0].id;
            await writeFirestoreDoc(primaryDb, 'draw_results', docId, dataToSave);
        } else {
            docId = await addFirestoreDoc(primaryDb, 'draw_results', dataToSave);
        }

        if (fecha === currentDay && tipoLoteria === 'zulia') {
            await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', { ultima_fecha_resultados_zulia: fecha });
            configuracion.ultima_fecha_resultados_zulia = fecha; // Actualizar caché de config
        }

        res.status(200).json({ message: 'Resultados de sorteo guardados/actualizados con éxito.' });
    } catch (error) {
        console.error('Error al guardar/actualizar resultados de sorteo en Firestore (Primary):', error.message); // Log más específico
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
    console.log(`[DEBUG_EXCEL] Iniciando generateGenericSalesExcelReport para: ${reportTitle}`);
    console.log(`[DEBUG_EXCEL] salesData recibida (${salesData.length} items):`, JSON.stringify(salesData.slice(0, 5), null, 2), `... (total: ${salesData.length} items)`); // Limitar log

    const now = moment().tz(CARACAS_TIMEZONE);
    const todayFormatted = now.format('YYYY-MM-DD');

    const totalVentasUSD = salesData.reduce((sum, venta) => sum + (venta.valueUSD || 0), 0);
    const totalVentasBs = salesData.reduce((sum, venta) => sum + (venta.valueBs || 0), 0);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(reportTitle);

    worksheet.columns = [
        { header: 'Campo', key: 'field', width: 25 },
        { header: 'Valor', key: 'value', width: 40 }
    ];

    worksheet.addRow({ field: 'Título del Reporte', value: reportTitle });
    worksheet.addRow({ field: 'Fecha y Hora del Reporte', value: now.format('YYYY-MM-DD HH:mm:ss') });
    worksheet.addRow({ field: 'Fecha de Sorteo Reportado', value: config.fecha_sorteo || 'N/A' });
    worksheet.addRow({ field: 'Número de Sorteo Reportado', value: String(config.numero_sorteo_correlativo || 'N/A') });
    worksheet.addRow({ field: 'Total de Tickets Vendidos', value: String(salesData.length || 0) });
    worksheet.addRow({ field: 'Total Vendido USD', value: totalVentasUSD.toFixed(2) });
    worksheet.addRow({ field: 'Total Vendido Bs', value: totalVentasBs.toFixed(2) });

    worksheet.addRow({});
    worksheet.addRow({ field: 'Detalle de Ventas' });
    worksheet.addRow({});

    const ventasHeaders = [
        { header: 'ID Interno Venta', key: 'id', width: 20 },
        { header: 'ID Firestore', key: 'firestoreId', width: 25 },
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
        { header: 'Razón Anulación', key: 'voidedReason', width: 30 },
        { header: 'Fecha Anulación', key: 'voidedAt', width: 25 },
        { header: 'Razón Cierre', key: 'closedReason', width: 30 },
        { header: 'Fecha Cierre', key: 'closedAt', width: 25 }
    ];
    worksheet.addRow(ventasHeaders.map(h => h.header));

    salesData.forEach((venta, index) => {
        worksheet.addRow({
            id: venta.id,
            firestoreId: venta.firestoreId || '',
            purchaseDate: venta.purchaseDate ? moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            drawDate: venta.drawDate || '',
            drawTime: venta.drawTime || 'N/A',
            drawNumber: venta.drawNumber || '',
            ticketNumber: venta.ticketNumber || '',
            buyerName: venta.buyerName || '',
            buyerPhone: venta.buyerPhone || '',
            numbers: (Array.isArray(venta.numbers) ? venta.numbers.join(', ') : (venta.numbers || '')),
            valueUSD: venta.valueUSD || 0,
            valueBs: venta.valueBs || 0,
            paymentMethod: venta.paymentMethod || '',
            paymentReference: venta.paymentReference || '',
            voucherURL: venta.voucherURL ? `${API_BASE_URL}${venta.voucherURL}` : '',
            validationStatus: venta.validationStatus || 'Pendiente',
            voidedReason: venta.voidedReason || '',
            voidedAt: venta.voidedAt ? moment(venta.voidedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            closedReason: venta.closedReason || '',
            closedAt: venta.closedAt ? moment(venta.closedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : ''
        });
    });

    const excelFileName = `${fileNamePrefix}_${todayFormatted}_${now.format('HHmmss')}.xlsx`;
    const excelFilePath = path.join(REPORTS_DIR, excelFileName);
    await workbook.xlsx.writeFile(excelFilePath);

    console.log(`[DEBUG_EXCEL] Excel generado en: ${excelFilePath}`);
    return { excelFilePath, excelFileName };
}

/**
 * Genera un buffer ZIP que contiene archivos Excel para cada colección de Firestore especificada.
 * @param {object} dbInstance - La instancia de Firestore desde la cual exportar.
 * @returns {Promise<Buffer>} Un buffer que representa el archivo ZIP.
 */
async function generateDatabaseBackupZipBuffer(dbInstance) {
    if (!dbInstance) {
        throw new Error("No se proporcionó una instancia de base de datos para el respaldo.");
    }
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    const output = new (require('stream').PassThrough)();
    archive.pipe(output);

    try {
        const collectionsToExport = ['app_config', 'raffle_numbers', 'sales', 'lottery_times', 'draw_results', 'prizes', 'winners'];

        for (const collectionName of collectionsToExport) {
            const snapshot = await dbInstance.collection(collectionName).get();
            const data = snapshot.docs.map(doc => ({ firestoreId: doc.id, ...doc.data() }));

            if (data.length > 0) {
                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet(collectionName);

                const allKeys = new Set();
                data.forEach(row => {
                    Object.keys(row).forEach(key => allKeys.add(key));
                });
                const columns = Array.from(allKeys).map(key => ({ header: key, key: key, width: 25 }));
                worksheet.columns = columns;

                worksheet.addRow(columns.map(col => col.header));
                data.forEach(row => {
                    const rowData = {};
                    columns.forEach(col => {
                        if (Array.isArray(row[col.key])) {
                            rowData[col.key] = row[col.key].join(', ');
                        } else if (typeof row[col.key] === 'object' && row[col.key] !== null) {
                            rowData[col.key] = JSON.stringify(row[col.key]);
                        } else {
                            rowData[col.key] = row[col.key];
                        }
                    });
                    worksheet.addRow(rowData);
                });

                const excelBuffer = await workbook.xlsx.writeBuffer();
                archive.append(excelBuffer, { name: `${collectionName}_firestore_backup.xlsx` });
            } else {
                console.log(`Colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'} está vacía, no se generó Excel para el backup.`);
            }
        }
        
        archive.finalize();

        return new Promise((resolve, reject) => {
            const buffers = [];
            output.on('data', chunk => buffers.push(chunk));
            output.on('end', () => resolve(Buffer.concat(buffers)));
            archive.on('error', err => reject(err));
        });

    } catch (error) {
        console.error('Error al generar el buffer ZIP de la base de datos:', error.message); // Log más específico
        throw error;
    }
}


app.post('/api/corte-ventas', async (req, res) => {
    console.log('[DEBUG_CORTE_VENTAS] Iniciando corte de ventas...');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const todayFormatted = now.format('YYYY-MM-DD');

        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración no disponible en Firestore (Primary) para corte de ventas. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        console.log('[DEBUG_CORTE_VENTAS] Configuración actual (desde Firestore Primary o memoria):', JSON.stringify(configuracion, null, 2));

        const salesSnapshot = await primaryDb.collection('sales')
                                      .where('drawDate', '==', configuracion.fecha_sorteo)
                                      .get();
        const ventasDelDia = salesSnapshot.docs
            .map(doc => ({ firestoreId: doc.id, ...doc.data() }))
            .filter(venta => venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente');

        console.log(`[DEBUG_CORTE_VENTAS] Ventas del día (${configuracion.fecha_sorteo}, Confirmadas/Pendientes) desde Firestore (Primary): ${ventasDelDia.length} items.`);
        console.log('[DEBUG_CORTE_VENTAS] Detalle de ventasDelDia (primeras 5):', JSON.stringify(ventasDelDia.slice(0, 5), null, 2));


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            ventasDelDia,
            configuracion,
            'Corte de Ventas',
            'Corte_Ventas'
        );
        console.log(`[DEBUG_CORTE_VENTAS] Excel de corte de ventas generado: ${excelFileName}`);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const totalVentasUSD = ventasDelDia.reduce((sum, venta) => sum + (venta.valueUSD || 0), 0);
            const totalVentasBs = ventasDelDia.reduce((sum, venta) => sum + (venta.valueBs || 0), 0);

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
            } else {
                console.log('[DEBUG_CORTE_VENTAS] Correo de corte de ventas enviado.');
            }
        }

        let latestConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (latestConfig) {
            configuracion = latestConfig;
        } else {
            console.warn('No se pudo cargar la última configuración para el reseteo de números. Usando la configuración en memoria.');
        }

        let latestHorariosZulia = await readFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance');
        if (latestHorariosZulia) {
            horariosZulia = latestHorariosZulia;
        } else {
            console.warn('No se pudieron cargar los últimos horarios de Zulia para el reseteo de números. Usando los horarios en memoria.');
        }


        const fechaSorteoConfigurada = configuracion.fecha_sorteo;
        const zuliaTimes = horariosZulia.zulia;

        let ultimaHoraSorteo = null;
        if (Array.isArray(zuliaTimes) && zuliaTimes.length > 0) {
            ultimaHoraSorteo = zuliaTimes.reduce((latestTime, currentTimeStr) => {
                const latestMoment = moment.tz(`${fechaSorteoConfigurada} ${latestTime}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                const currentMoment = moment.tz(`${fechaSorteoConfigurada} ${currentTimeStr}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                return currentMoment.isAfter(latestMoment) ? currentTimeStr : latestTime;
            }, zuliaTimes[0]);
        }

        const currentMomentInCaracas = moment().tz(CARACAS_TIMEZONE);
        const drawDateMoment = moment(fechaSorteoConfigurada, 'YYYY-MM-DD').tz(CARACAS_TIMEZONE);

        let shouldResetNumbers = false;
        let message = 'Corte de ventas realizado. Los números no han sido reseteados según la hora de sorteo y reservas.';

        if (ultimaHoraSorteo) {
            const ultimaHoraSorteoMoment = moment.tz(`${fechaSorteoConfigurada} ${ultimaHoraSorteo}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);

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
            const currentDrawCorrelativo = parseInt(configuracion.numero_sorteo_correlativo);
            const numbersToLiberateSnapshot = await primaryDb.collection('raffle_numbers')
                                                      .where('comprado', '==', true)
                                                      .where('originalDrawNumber', '<', currentDrawCorrelativo - 1)
                                                      .get();
            const primaryBatch = primaryDb.batch();
            let changedCount = 0;

            numbersToLiberateSnapshot.docs.forEach(doc => {
                const numRefPrimary = primaryDb.collection('raffle_numbers').doc(doc.id);
                primaryBatch.update(numRefPrimary, { comprado: false, originalDrawNumber: null });
                changedCount++;
                console.log(`Número ${doc.id} liberado en Firestore (Primary). Comprado originalmente para sorteo ${doc.data().originalDrawNumber}, ahora en sorteo ${currentDrawCorrelativo}.`);
            });

            if (changedCount > 0) {
                await primaryBatch.commit();
                console.log(`Se liberaron ${changedCount} números antiguos en Firestore (Primary).`);
            } else {
                console.log('No hay números antiguos para liberar en Firestore en este momento.');
            }
        }

        res.status(200).json({ message: message });

    } catch (error) {
    console.error('Error al realizar Corte de Ventas en Firestore (Primary):', error.message); // Log más específico
    res.status(500).json({ message: 'Error interno del servidor al realizar Corte de Ventas.', error: error.message });
    }
});


// --- RUTAS PARA PREMIOS ---

app.get('/api/premios', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Se requiere una fecha válida (YYYY-MM-DD) para obtener los premios.' });
    }

    const fechaFormateada = moment.tz(fecha, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        // Leer de la DB principal
        const allPremios = await readFirestoreDoc(primaryDb, 'prizes', 'daily_prizes');
        if (allPremios) {
            premios = allPremios; // Actualizar caché
        }

        const premiosDelDia = premios[fechaFormateada] || {};

        const premiosParaFrontend = {
            fechaSorteo: fechaFormateada,
            sorteo12PM: premiosDelDia.sorteo12PM || { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo3PM: premiosDelDia.sorteo3PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' },
            sorteo5PM: premiosDelDia.sorteo5PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' }
        };

        res.status(200).json(premiosParaFrontend);
    } catch (error) {
        console.error('Error al obtener premios de Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener premios.' });
    }
});

app.post('/api/premios', async (req, res) => {
    const { fechaSorteo, sorteo12PM, sorteo3PM, sorteo5PM } = req.body;

    if (!fechaSorteo || !moment(fechaSorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'La fecha del sorteo (YYYY-MM-DD) es requerida y debe ser válida para guardar premios.' });
    }

    const fechaFormateada = moment.tz(fechaSorteo, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        let allPremios = await readFirestoreDoc(primaryDb, 'prizes', 'daily_prizes');
        if (!allPremios) allPremios = {};

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

        // Escribir en la base de datos principal
        await writeFirestoreDoc(primaryDb, 'prizes', 'daily_prizes', allPremios);
        premios = allPremios; // Actualizar caché
        console.log('Premios guardados/actualizados en Firestore (Primary) y caché.');

        res.status(200).json({ message: 'Premios guardados/actualizados con éxito.', premiosGuardados: allPremios[fechaFormateada] });

    } catch (error) {
        console.error('Error al guardar premios en Firestore (Primary):', error.message); // Log más específico
        console.error('Detalle del error:', error.stack);
        res.status(500).json({ message: 'Error interno del servidor al guardar premios.', error: error.message });
    }
});

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
        console.error('Error en la ruta /api/send-test-email:', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al enviar correo de prueba.', error: error.message });
    }
});

app.put('/api/tickets/validate/:id', async (req, res) => {
    const ventaId = parseInt(req.params.id);
    const { validationStatus } = req.body;

    const estadosValidos = ['Confirmado', 'Falso', 'Pendiente'];
    if (!validationStatus || !estadosValidos.includes(validationStatus)) {
        return res.status(400).json({ message: 'Estado de validación inválido. Debe ser "Confirmado", "Falso" o "Pendiente".' });
    }

    try {
        const salesSnapshot = await primaryDb.collection('sales').where('id', '==', ventaId).limit(1).get();
        if (salesSnapshot.empty) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }
        const ventaDoc = salesSnapshot.docs[0];
        const ventaData = ventaDoc.data();
        const firestoreVentaId = ventaDoc.id;

        const oldValidationStatus = ventaData.validationStatus;

        // Actualizar en la base de datos principal
        await writeFirestoreDoc(primaryDb, 'sales', firestoreVentaId, { validationStatus: validationStatus });

        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            const numerosAnulados = ventaData.numbers;
            if (numerosAnulados && numerosAnulados.length > 0) {
                const primaryBatch = primaryDb.batch();

                numerosAnulados.forEach(numAnulado => {
                    const numRefPrimary = primaryDb.collection('raffle_numbers').doc(numAnulado);
                    primaryBatch.update(numRefPrimary, { comprado: false, originalDrawNumber: null });
                });
                await primaryBatch.commit();
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} (marcada como Falsa) han sido puestos nuevamente disponibles en Firestore (Primary).`);
            }
        }

        res.status(200).json({ message: `Estado de la venta ${ventaId} actualizado a "${validationStatus}" con éxito.`, venta: { id: ventaId, ...ventaData, validationStatus: validationStatus } });
    } catch (error) {
        console.error(`Error al actualizar el estado de la venta ${ventaId} en Firestore (Primary):`, error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al actualizar el estado de la venta.', error: error.message });
    }
});


// Endpoint para exportar toda la base de datos en un archivo ZIP
app.get('/api/export-database', async (req, res) => {
    const archiveName = `rifas_db_backup_${moment().format('YYYYMMDD_HHmmss')}.zip`;
    res.attachment(archiveName);

    try {
        // Siempre exportar desde la base de datos principal
        const zipBuffer = await generateDatabaseBackupZipBuffer(primaryDb);
        res.status(200).send(zipBuffer);
        console.log('Base de datos (Primary) exportada y enviada como ZIP.');
    } catch (error) {
        console.error('Error al exportar la base de datos:', error.message); // Log más específico
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
        const salesSnapshot = await primaryDb.collection('sales').where('id', '==', ventaId).limit(1).get();
        if (salesSnapshot.empty) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp.' });
        }
        const venta = salesSnapshot.docs[0].data();

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
        console.error('Error al generar el enlace de WhatsApp para el cliente:', error.message); // Log más específico
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
        const salesSnapshot = await primaryDb.collection('sales').where('id', '==', ventaId).limit(1).get();
        if (salesSnapshot.empty) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp de pago falso.' });
        }
        const venta = salesSnapshot.docs[0].data();

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
        console.error('Error al generar el enlace de WhatsApp para pago falso:', error.message); // Log más específico
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
            `¡Felicidades, ${buyerName}! 🎉�🎉\n\n` +
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

        console.log(`Generado enlace de WhatsApp para notificar a ${buyerName} (${buyerPhone}): ${whatsappLink}`);

        res.status(200).json({ message: 'Enlace de notificación de WhatsApp generado con éxito. Se intentará abrir WhatsApp.', whatsappLink: whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para notificar al ganador:', error.message); // Log más específico
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
        const allVentasSnapshot = await primaryDb.collection('sales').get();
        const allVentas = allVentasSnapshot.docs.map(doc => doc.data());

        const allResultadosSorteoSnapshot = await primaryDb.collection('draw_results').get();
        const allResultadosSorteo = allResultadosSorteoSnapshot.docs.map(doc => doc.data());

        let premiosDoc = await readFirestoreDoc(primaryDb, 'prizes', 'daily_prizes');
        if (!premiosDoc) {
            console.warn('Documento de premios no encontrado en Firestore (Primary) para procesar ganadores. Usando la caché en memoria.');
            premiosDoc = { ...premios };
        }
        const allPremios = premiosDoc;

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

        for (const venta of allVentas) {
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
                    let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
                    if (currentConfig) {
                        configuracion = currentConfig;
                    } else {
                        console.warn('No se pudo cargar la última configuración para procesar ganadores. Usando la configuración en memoria.');
                    }
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
        }

        const now = moment().tz(CARACAS_TIMEZONE).toISOString();
        const newWinnersEntry = {
            drawDate: fecha,
            drawNumber: parseInt(numeroSorteo),
            lotteryType: tipoLoteria,
            winners: ticketsGanadoresParaEsteSorteo,
            processedAt: now
        };

        const existingWinnersSnapshot = await primaryDb.collection('winners')
                                                .where('drawDate', '==', fecha)
                                                .where('drawNumber', '==', parseInt(numeroSorteo))
                                                .where('lotteryType', '==', tipoLoteria)
                                                .limit(1)
                                                .get();

        let docId;
        if (!existingWinnersSnapshot.empty) {
            docId = existingWinnersSnapshot.docs[0].id;
            await writeFirestoreDoc(primaryDb, 'winners', docId, newWinnersEntry);
            console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} actualizados en Firestore (Primary).`);
        } else {
            docId = await addFirestoreDoc(primaryDb, 'winners', newWinnersEntry);
            console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} añadidos a Firestore (Primary).`);
        }

        res.status(200).json({ message: 'Ganadores procesados y guardados con éxito.', totalGanadores: ticketsGanadoresParaEsteSorteo.length });

    } catch (error) {
        console.error('Error al procesar y guardar tickets ganadores en Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al procesar y guardar tickets ganadores.', error: error.message });
    }
});


// GET /api/tickets/ganadores (ahora siempre desde Firestore Primary)
app.get('/api/tickets/ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.query;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos.' });
    }

    try {
        const winnersSnapshot = await primaryDb.collection('winners')
                                        .where('drawDate', '==', fecha)
                                        .where('drawNumber', '==', parseInt(numeroSorteo))
                                        .where('lotteryType', '==', tipoLoteria)
                                        .limit(1)
                                        .get();

        if (!winnersSnapshot.empty) {
            const foundEntry = winnersSnapshot.docs[0].data();
            res.status(200).json({ ganadores: foundEntry.winners });
        } else {
            res.status(200).json({ ganadores: [], message: 'No se encontraron tickets ganadores procesados para esta consulta.' });
        }
    } catch (error) {
        console.error('Error al obtener ganadores desde Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al obtener ganadores.', error: error.message });
    }
});

// Función para liberar números que ya excedieron la reserva de 2 sorteos
async function liberateOldReservedNumbers(currentDrawCorrelativo) {
    console.log(`[liberateOldReservedNumbers] Revisando números para liberar (correlativo actual: ${currentDrawCorrelativo})...`);
    
    const numbersToLiberateSnapshot = await primaryDb.collection('raffle_numbers')
                                              .where('comprado', '==', true)
                                              .where('originalDrawNumber', '<', currentDrawCorrelativo - 1)
                                              .get();
    const primaryBatch = primaryDb.batch();
    let changedCount = 0;

    numbersToLiberateSnapshot.docs.forEach(doc => {
        const numRefPrimary = primaryDb.collection('raffle_numbers').doc(doc.id);
        primaryBatch.update(numRefPrimary, { comprado: false, originalDrawNumber: null });
        changedCount++;
        console.log(`Número ${doc.id} liberado en Firestore (Primary). Comprado originalmente para sorteo ${doc.data().originalDrawNumber}, ahora en sorteo ${currentDrawCorrelativo}.`);
    });

    if (changedCount > 0) {
        await primaryBatch.commit();
        console.log(`Se liberaron ${changedCount} números antiguos en Firestore (Primary).`);
    } else {
        console.log('No hay números antiguos para liberar en Firestore en este momento.');
    }
}

// Función auxiliar para avanzar la configuración del sorteo (fecha, correlativo, último ticket)
async function advanceDrawConfiguration(currentConfig, targetDate) {
    const updatedConfig = {
        fecha_sorteo: targetDate,
        numero_sorteo_correlativo: (currentConfig.numero_sorteo_correlativo || 0) + 1,
        ultimo_numero_ticket: 0,
        pagina_bloqueada: false,
        last_sales_notification_count: 0,
        block_reason_message: ""
    };
    await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', updatedConfig);
    configuracion = { ...configuracion, ...updatedConfig };

    console.log(`Configuración avanzada en Firestore (Primary) para el siguiente sorteo: Fecha ${configuracion.fecha_sorteo}, Correlativo ${configuracion.numero_sorteo_correlativo}.`);
}


/**
 * Evalúa el estado del sorteo actual basándose en el porcentaje de ventas
 * y actualiza el estado de los tickets en Firestore, sin avanzar la fecha del sorteo.
 * @param {moment.Moment} nowMoment - El objeto moment actual para la hora de Caracas.
 * @returns {Promise<Object>} Resultado de la evaluación.
 */
async function evaluateDrawStatusOnly(nowMoment) {
    console.log(`[evaluateDrawStatusOnly] Iniciando evaluación de estado de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para evaluación. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        
        const currentDrawDateStr = currentConfig.fecha_sorteo;

        const salesSnapshot = await primaryDb.collection('sales')
                                      .where('drawDate', '==', currentDrawDateStr)
                                      .get();
        const soldTicketsForCurrentDraw = salesSnapshot.docs
            .map(doc => ({ firestoreId: doc.id, ...doc.data() }))
            .filter(venta => venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente');
        const totalSoldTicketsCount = soldTicketsForCurrentDraw.length;


        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalSoldTicketsCount / totalPossibleTickets) * 100;

        console.log(`[evaluateDrawStatusOnly] Tickets vendidos para el sorteo del ${currentDrawDateStr}: ${totalSoldTicketsCount}/${totalPossibleTickets} (${soldPercentage.toFixed(2)}%)`);

        let message = '';
        let whatsappMessageContent = '';
        let emailSubject = '';
        let emailHtmlContent = '';
        let excelReport = { excelFilePath: null, excelFileName: null };

        const primaryBatch = primaryDb.batch();

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados en Firestore.`);

            soldTicketsForCurrentDraw.forEach(venta => {
                const ventaRefPrimary = primaryDb.collection('sales').doc(venta.firestoreId);
                primaryBatch.update(ventaRefPrimary, {
                    validationStatus: 'Anulado por bajo porcentaje',
                    voidedReason: 'Ventas insuficientes para el sorteo',
                    voidedAt: nowMoment.toISOString()
                });
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
            await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', {
                pagina_bloqueada: true,
                block_reason_message: "El sorteo ha sido ANULADO por bajo porcentaje de ventas. Tus tickets válidos han sido revalidados para el próximo sorteo. ¡Vuelve pronto!"
            });
            configuracion.pagina_bloqueada = true;
            configuracion.block_reason_message = "El sorteo ha sido ANULADO por bajo porcentaje de ventas. Tus tickets válidos han sido revalidados para el próximo sorteo. ¡Vuelve pronto!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                currentConfig,
                `Reporte de Suspensión del Sorteo ${currentDrawDateStr}`,
                'Reporte_Suspension'
            );

        } else {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) cumplen o superan el ${SALES_THRESHOLD_PERCENTAGE}%. Marcando tickets como cerrados en Firestore.`);

            soldTicketsForCurrentDraw.forEach(venta => {
                const ventaRefPrimary = primaryDb.collection('sales').doc(venta.firestoreId);
                primaryBatch.update(ventaRefPrimary, {
                    validationStatus: 'Cerrado por Suficiencia de Ventas',
                    closedReason: 'Ventas suficientes para el sorteo',
                    closedAt: nowMoment.toISOString()
                });
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
            await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', {
                pagina_bloqueada: true,
                block_reason_message: "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!"
            });
            configuracion.pagina_bloqueada = true;
            configuracion.block_reason_message = "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                currentConfig,
                `Reporte de Cierre del Sorteo ${currentDrawDateStr}`,
                'Reporte_Cierre'
            );
        }

        await primaryBatch.commit();
        console.log('[evaluateDrawStatusOnly] Estado de ventas actualizado en Firestore (Primary).');

        await sendWhatsappNotification(whatsappMessageContent);

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

        return { success: true, message: message, evaluatedDate: currentDrawDateStr, salesPercentage: soldPercentage };

    } catch (error) {
        console.error('[evaluateDrawStatusOnly] ERROR durante la evaluación del sorteo en Firestore (Primary):', error.message); // Log más específico
        return { success: false, message: `Error interno al evaluar estado de sorteo: ${error.message}` };
    }
}


// --- Lógica central para la verificación, anulación/cierre y AVANCE del sorteo (Cierre Manual) ---
async function cerrarSorteoManualmente(nowMoment) {
    console.log(`[cerrarSorteoManualmente] Iniciando cierre manual de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para cierre manual. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        
        const currentDrawCorrelativo = configuracion.numero_sorteo_correlativo;

        const evaluationResult = await evaluateDrawStatusOnly(nowMoment);
        if (!evaluationResult.success) {
            return evaluationResult;
        }

        await liberateOldReservedNumbers(currentDrawCorrelativo);

        const nextDayDate = nowMoment.clone().add(1, 'days').format('YYYY-MM-DD');
        await advanceDrawConfiguration(currentConfig, nextDayDate);

        const whatsappMessage = `*¡Sorteo Finalizado y Avanzado!* 🥳\n\nEl sorteo del *${evaluationResult.evaluatedDate}* ha sido finalizado. Ventas: *${evaluationResult.salesPercentage.toFixed(2)}%*.\n\nLa configuración ha avanzado al Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha *${configuracion.fecha_sorteo}*.`;
        await sendWhatsappNotification(whatsappMessage);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `CONFIRMACIÓN: Avance de Sorteo Manual - A Sorteo ${configuracion.numero_sorteo_correlativo}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les confirma que se ha realizado el <strong>avance de sorteo manual</strong>.</p>
                <p><b>Sorteo Anterior:</b> Fecha ${evaluationResult.evaluatedDate}, Ventas ${evaluationResult.salesPercentage.toFixed(2)}%</p>
                <p><b>Nuevo Sorteo Activo:</b> Nro. <b>${configuracion.numero_sorteo_correlativo}</b> para la fecha <b>${configuracion.fecha_sorteo}</b>.</p>
                <p>La página de compra ha sido desbloqueada para nuevas ventas.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent);
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
        console.error('[cerrarSorteoManualmente] ERROR durante el cierre manual del sorteo en Firestore (Primary):', error.message); // Log más específico
        return { success: false, message: `Error interno: ${error.message}` };
    }
}


// --- ENDPOINT PARA CIERRE MANUAL DEL SORTEO (Full Close + Advance) ---
app.post('/api/cerrar-sorteo-manualmente', async (req, res) => {
    console.log('API: Recibida solicitud para cierre manual de sorteo.');
    try {
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para cierre manual. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        
        const currentDrawDateStr = configuracion.fecha_sorteo;

        const simulatedMoment = moment().tz(CARACAS_TIMEZONE);
        const currentDrawDateMoment = moment.tz(currentDrawDateStr, 'YYYY-MM-DD', CARACAS_TIMEZONE);

        if (simulatedMoment.isSame(currentDrawDateMoment, 'day')) {
             simulatedMoment.set({ hour: DRAW_SUSPENSION_HOUR, minute: DRAW_SUSPENSION_MINUTE + 5, second: 0 });
        } else if (simulatedMoment.isBefore(currentDrawDateMoment, 'day')) {
             return res.status(400).json({ message: 'No se puede cerrar manualmente un sorteo cuya fecha aún no ha llegado.' });
        }

        const result = await cerrarSorteoManualmente(simulatedMoment);

        if (result.success) {
            res.status(200).json({ message: result.message, closedDate: result.closedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de cierre manual de sorteo en Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al cerrar el sorteo manualmente.', error: error.message });
    }
});


// --- ENDPOINT PARA SUSPENDER SORTEO (Evaluate Sales Only) ---
app.post('/api/suspender-sorteo', async (req, res) => {
    console.log('API: Recibida solicitud para suspender sorteo (evaluación de ventas).');
    try {
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para suspensión. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        
        const now = moment().tz(CARACAS_TIMEZONE);

        const result = await evaluateDrawStatusOnly(now);
        if (result.success) {
            res.status(200).json({ message: result.message, evaluatedDate: result.evaluatedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de suspensión de sorteo en Firestore (Primary):', error.message); // Log más específico
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
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para establecer fecha manual. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        
        const oldDrawDate = currentConfig.fecha_sorteo;
        const oldDrawCorrelativo = currentConfig.numero_sorteo_correlativo; 

        await advanceDrawConfiguration(currentConfig, newDrawDate);

        await liberateOldReservedNumbers(configuracion.numero_sorteo_correlativo);

        const salesForOldDrawSnapshot = await primaryDb.collection('sales')
                                                .where('drawDate', '==', oldDrawDate)
                                                .get();
        const salesForOldDraw = salesForOldDrawSnapshot.docs
            .map(doc => doc.data())
            .filter(venta => ['Confirmado', 'Pendiente', 'Cerrado por Suficiencia de Ventas', 'Anulado por bajo porcentaje'].includes(venta.validationStatus));


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            salesForOldDraw,
            { fecha_sorteo: oldDrawDate, numero_sorteo_correlativo: oldDrawCorrelativo },
            `Reporte de Reprogramación del Sorteo ${oldDrawDate}`,
            'Reporte_Reprogramacion'
        );

        const whatsappMessage = `*¡Sorteo Reprogramado!* 🗓️\n\nLa fecha del sorteo ha sido actualizada manualmente. Anteriormente Sorteo Nro. *${oldDrawCorrelativo}* de fecha *${oldDrawDate}*.\n\nAhora Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha: *${newDrawDate}*.\n\n¡La página de compra está nuevamente activa!`;
        await sendWhatsappNotification(whatsappMessage);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `NOTIFICACIÓN: Sorteo Reprogramado - Nueva Fecha ${newDrawDate}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo ha sido <strong>reprogramado manualmente</strong>.</p>
                <p><b>Fecha Anterior:</b> ${oldDrawDate} (Sorteo Nro. ${oldDrawCorrelativo})</p>
                <p><b>Nueva Fecha:</b> ${newDrawDate} (Sorteo Nro. ${configuracion.numero_sorteo_correlativo})</p>
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

            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de reprogramación.');
            }
        }

        res.status(200).json({
            success: true,
            message: `Fecha del sorteo actualizada manualmente a ${newDrawDate}. El número de sorteo ha avanzado al ${configuracion.numero_sorteo_correlativo} y los números reservados antiguos han sido liberados.`,
            newConfig: configuracion
        });

    } catch (error) {
        console.error('Error en la API de set-manual-draw-date en Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al establecer la fecha del sorteo manualmente.', error: error.message });
    }
});


// NUEVO ENDPOINT: Notificación de ventas para desarrolladores
app.post('/api/developer-sales-notification', async (req, res) => {
    console.log('API: Recibida solicitud para notificación de ventas para desarrolladores.');
    try {
        let currentConfig = await readFirestoreDoc(primaryDb, 'app_config', 'main_config');
        if (!currentConfig) {
            console.warn('Configuración de la aplicación no disponible en Firestore (Primary) para notificación de desarrolladores. Usando la configuración en memoria.');
            currentConfig = { ...configuracion };
        }
        configuracion = currentConfig;
        
        const now = moment().tz(CARACAS_TIMEZONE);

        const currentDrawDateStr = configuracion.fecha_sorteo;
        const salesSnapshot = await primaryDb.collection('sales')
                                      .where('drawDate', '==', currentDrawDateStr)
                                      .get();
        const ventasParaFechaSorteo = salesSnapshot.docs
            .map(doc => doc.data())
            .filter(venta => venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente');

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
        console.error('Error al enviar notificación de ventas para desarrolladores desde Firestore (Primary):', error.message); // Log más específico
        res.status(500).json({ message: 'Error interno del servidor al enviar notificación de ventas para desarrolladores.', error: error.message });
    }
});


// Endpoint para limpiar todos los datos (útil para reinicios de sorteo)
app.post('/api/admin/limpiar-datos', async (req, res) => {
    // Pasar las dependencias necesarias a la función importada
    // handleLimpiarDatos ahora solo acepta primaryDb
    await handleLimpiarDatos(primaryDb, configuracion, CARACAS_TIMEZONE, loadInitialData, res);
});


// Tareas programadas (Cron Jobs)
// Se ejecutarán después de que el servidor se inicie y los datos se carguen

/**
 * Función asíncrona para la tarea programada de verificación diaria de ventas
 * y posible anulación/cierre de sorteo, y avance al siguiente sorteo.
 */
async function dailyDrawCheckCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para verificar ventas y posible anulación/cierre de sorteo.');
    const cronResult = await cerrarSorteoManualmente(moment().tz(CARACAS_TIMEZONE));
    console.log(`CRON JOB Resultado: ${cronResult.message}`);
}

cron.schedule('15 12 * * *', dailyDrawCheckCronJob, {
    timezone: CARACAS_TIMEZONE
});

/**
 * Función asíncrona para la tarea programada de Notificación de ventas por WhatsApp y Email.
 * Se ejecuta periódicamente para enviar resúmenes de ventas a los administradores.
 */
async function salesSummaryCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para enviar notificación de resumen de ventas por WhatsApp y Email.');
    await sendSalesSummaryNotifications();
}

cron.schedule('*/55 * * * *', salesSummaryCronJob);

/**
 * NUEVA FUNCIÓN CRON JOB: Respaldo automático de la base de datos y envío por correo.
 * Se ejecuta cada 55 minutos para generar un backup y enviarlo.
 */
async function dailyDatabaseBackupCronJob() {
    console.log('CRON JOB: Iniciando respaldo automático de la base de datos y envío por correo.');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const backupFileName = `rifas_db_backup_${now.format('YYYYMMDD_HHmmss')}.zip`;
        // Siempre generar el backup desde la base de datos principal
        const zipBuffer = await generateDatabaseBackupZipBuffer(primaryDb);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `Respaldo Automático de Base de Datos - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se ha generado el respaldo automático de la base de datos de Rifas.</p>
                <p>Fecha y Hora del Respaldo: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
                <p>Adjunto encontrarás el archivo ZIP con los datos de Firestore exportados a Excel.</p>
                <p>Por favor, guarden este archivo en un lugar seguro.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = [
                {
                    filename: backupFileName,
                    content: zipBuffer,
                    contentType: 'application/zip'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (emailSent) {
                console.log('Respaldo de base de datos enviado por correo exitosamente.');
            } else {
                console.error('Fallo al enviar el correo de respaldo de base de datos.');
            }
        } else {
            console.warn('No hay correos de administrador configurados para enviar el respaldo de la base de datos.');
        }
    } catch (error) {
        console.error('Error durante el cron job de respaldo automático de la base de datos:', error.message); // Log más específico
    }
}

cron.schedule('*/55 * * * *', dailyDatabaseBackupCronJob, {
    timezone: CARACAS_TIMEZONE
});


// Inicialización del servidor
(async () => {
    try {
        console.log('DEBUG: Iniciando IIFE de inicialización del servidor.');
        await ensureDataAndComprobantesDirs();
        console.log('DEBUG: Directorios asegurados.');
        await loadInitialData();
        console.log('DEBUG: Datos iniciales cargados.');
        configureMailer();
        console.log('DEBUG: Mailer configurado.');
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
        });
    } catch (err) {
        console.error('Failed to initialize data and start server:', err.message); // Log más específico
        process.exit(1);
    }
})();
