// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises; // Todavía necesario para directorios y archivos de reportes/comprobantes
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone');
const archiver = require('archiver');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
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

// Rutas a tus archivos locales (solo para directorios y archivos no críticos/temporales)
const UPLOADS_DIR = path.join(__dirname, 'uploads'); // Para comprobantes
const REPORTS_DIR = path.join(__dirname, 'reports'); // Para reportes Excel

// --- Variables globales en memoria (caché de Firestore para datos pequeños y frecuentes) ---
// Estas variables se cargarán UNA VEZ al inicio del servidor y se actualizarán
// solo cuando se realicen escrituras a Firestore o lecturas críticas.
let configuracion = {};
let numeros = []; // Caché de los 1000 números de la rifa (estado comprado/no comprado)
let horariosZulia = { zulia: [], chance: [] };
let premios = {}; // Caché para los premios

let db; // Instancia de Firestore

const SALES_THRESHOLD_PERCENTAGE = 80;
const DRAW_SUSPENSION_HOUR = 12;
const DRAW_SUSPENSION_MINUTE = 15;
const TOTAL_RAFFLE_NUMBERS = 1000;

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
    db = admin.firestore(); // Inicializa la referencia a Firestore
    console.log('Firebase Admin SDK inicializado exitosamente.');
} catch (error) {
    console.error('Error al inicializar Firebase Admin SDK:', error);
    process.exit(1); // Salir si no se puede inicializar Firebase
}

// --- Funciones Auxiliares para Firestore ---

/**
 * Lee un documento específico de una colección en Firestore.
 * @param {string} collectionName - Nombre de la colección.
 * @param {string} docId - ID del documento.
 * @returns {Promise<Object|null>} El objeto del documento o null si no existe.
 */
async function readFirestoreDoc(collectionName, docId) {
    try {
        const docRef = db.collection(collectionName).doc(docId);
        const doc = await docRef.get();
        if (doc.exists) {
            return doc.data();
        }
        return null;
    } catch (error) {
        console.error(`Error leyendo documento ${docId} en colección ${collectionName}:`, error);
        return null;
    }
}

/**
 * Escribe o actualiza un documento específico en una colección de Firestore.
 * @param {string} collectionName - Nombre de la colección.
 * @param {string} docId - ID del documento.
 * @param {Object} data - Los datos a guardar.
 * @returns {Promise<boolean>} True si la operación fue exitosa.
 */
async function writeFirestoreDoc(collectionName, docId, data) {
    try {
        await db.collection(collectionName).doc(docId).set(data, { merge: true });
        return true;
    } catch (error) {
        console.error(`Error escribiendo documento ${docId} en colección ${collectionName}:`, error);
        return false;
    }
}

/**
 * Lee todos los documentos de una colección en Firestore.
 * NOTA: Esta función debe usarse con precaución para colecciones grandes,
 * ya que puede agotar la cuota de Firestore. Se usa principalmente para
 * colecciones pequeñas o cuando se necesita la lista completa para una
 * operación específica (ej. exportación de datos).
 * @param {string} collectionName - Nombre de la colección.
 * @returns {Promise<Array>} Un array de objetos de documentos.
 */
async function readFirestoreCollection(collectionName) {
    try {
        const snapshot = await db.collection(collectionName).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        console.error(`Error leyendo colección ${collectionName}:`, error);
        return [];
    }
}

/**
 * Añade un nuevo documento a una colección con un ID generado automáticamente.
 * @param {string} collectionName - Nombre de la colección.
 * @param {Object} data - Los datos a añadir.
 * @returns {Promise<string|null>} El ID del nuevo documento o null en caso de error.
 */
async function addFirestoreDoc(collectionName, data) {
    try {
        const docRef = await db.collection(collectionName).add(data);
        return docRef.id;
    } catch (error) {
        console.error(`Error añadiendo documento a colección ${collectionName}:`, error);
        return null;
    }
}

/**
 * Elimina un documento de una colección.
 * @param {string} collectionName - Nombre de la colección.
 * @param {string} docId - ID del documento a eliminar.
 * @returns {Promise<boolean>} True si la operación fue exitosa.
 */
async function deleteFirestoreDoc(collectionName, docId) {
    try {
        await db.collection(collectionName).doc(docId).delete();
        return true;
    } catch (error) {
        console.error(`Error eliminando documento ${docId} de colección ${collectionName}:`, error);
        return false;
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

// Carga inicial de datos desde Firestore (SE EJECUTA SOLO UNA VEZ AL INICIO DEL SERVIDOR)
async function loadInitialData() {
    console.log('Iniciando carga inicial de datos desde Firestore...');
    try {
        // Cargar configuración (documento único y pequeño)
        let configDoc = await readFirestoreDoc('app_config', 'main_config');
        if (!configDoc) {
            console.warn('Documento de configuración no encontrado en Firestore. Creando uno por defecto.');
            configuracion = {
                "precio_ticket": 0.50,
                "tasa_dolar": 36.50,
                "fecha_sorteo": moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
                "numero_sorteo_correlativo": 1,
                "ultimo_numero_ticket": 0,
                "pagina_bloqueada": false,
                "block_reason_message": "",
                "mail_config": {
                    "host": "smtp.gmail.com",
                    "port": 465,
                    "secure": true,
                    "user": process.env.EMAIL_USER || "tu_correo@gmail.com",
                    "pass": process.env.EMAIL_PASS || "tu_contraseña_o_app_password",
                    "senderName": "Sistema de Rifas"
                },
                "admin_whatsapp_numbers": ["584126083355", "584143630488", "584124723776"],
                "last_sales_notification_count": 0,
                "sales_notification_threshold": 20,
                "admin_email_for_reports": ["tu_correo@gmail.com"],
                "ultima_fecha_resultados_zulia": null
            };
            await writeFirestoreDoc('app_config', 'main_config', configuracion);
        } else {
            configuracion = configDoc;
        }

        // Cargar números (solo si la colección está vacía, no se carga en caché de memoria si ya existe)
        let numerosSnapshot = await db.collection('raffle_numbers').get();
        if (numerosSnapshot.empty) {
            console.warn('Colección de números de rifa vacía. Inicializando con 1000 números por defecto.');
            const batch = db.batch();
            for (let i = 0; i < 1000; i++) {
                const numStr = i.toString().padStart(3, '0');
                const numRef = db.collection('raffle_numbers').doc(numStr);
                batch.set(numRef, { numero: numStr, comprado: false, originalDrawNumber: null });
            }
            await batch.commit();
            // Si se inicializa, la caché en memoria se llena.
            numeros = Array.from({ length: 1000 }, (_, i) => ({
                numero: i.toString().padStart(3, '0'),
                comprado: false,
                originalDrawNumber: null
            }));
        } else {
            // Si la colección de números ya existe, NO la cargamos toda en memoria al inicio.
            // La caché 'numeros' se mantendrá vacía o se actualizará solo con escrituras.
            // Las lecturas del estado de los números se harán directamente a Firestore cuando sea necesario (ej. en la compra).
            console.log('Colección de números de rifa ya existe. No se cargan todos los números en memoria al inicio.');
            numeros = []; // Asegurarse de que la caché esté vacía o se maneje por demanda.
        }

        // Cargar horarios (documento único y pequeño)
        let horariosDoc = await readFirestoreDoc('lottery_times', 'zulia_chance');
        if (!horariosDoc) {
            console.warn('Documento de horarios no encontrado en Firestore. Creando uno por defecto.');
            horariosZulia = {
                zulia: ["12:00 PM", "04:00 PM", "07:00 PM"],
                chance: ["01:00 PM", "05:00 PM", "08:00 PM"]
            };
            await writeFirestoreDoc('lottery_times', 'zulia_chance', horariosZulia);
        } else {
            horariosZulia = horariosDoc;
        }

        // Cargar premios (documento único y pequeño)
        let premiosDoc = await readFirestoreDoc('prizes', 'daily_prizes');
        if (!premiosDoc) {
            console.warn('Documento de premios no encontrado en Firestore. Inicializando vacío.');
            premios = {};
            await writeFirestoreDoc('prizes', 'daily_prizes', premios);
        } else {
            premios = premiosDoc;
        }
        
        // NOTA IMPORTANTE: Las colecciones 'sales', 'draw_results' y 'winners'
        // NO se cargan aquí al inicio, ya que pueden ser muy grandes y agotar la cuota.
        // Se leerán directamente de Firestore en los endpoints que las requieran.
        console.log('Datos iniciales (configuración, horarios, premios) cargados desde Firestore y en caché. Números de rifa manejados de forma optimizada.');
    } catch (error) {
        console.error('Error al cargar datos iniciales desde Firestore:', error);
        // Si hay un error crítico al cargar, es mejor salir o tener un fallback seguro
        process.exit(1);
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
        console.error('Error al enviar correo:', error);
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
        console.error('Error al enviar notificación por WhatsApp:', error);
    }
}

// Función auxiliar para enviar notificación de resumen de ventas (WhatsApp y Email)
async function sendSalesSummaryNotifications() {
    // Para esta función de CRON, necesitamos la configuración y ventas más recientes.
    // Recargar configuración para asegurar que `last_sales_notification_count` y `sales_notification_threshold` estén al día.
    configuracion = await readFirestoreDoc('app_config', 'main_config');
    if (!configuracion) {
        console.error('No se pudo cargar la configuración para sendSalesSummaryNotifications.');
        return;
    }

    console.log('[sendSalesSummaryNotifications] Iniciando notificación de resumen de ventas.');
    const now = moment().tz(CARACAS_TIMEZONE);

    // Obtener ventas directamente de Firestore para la fecha del sorteo actual
    const salesSnapshot = await db.collection('sales').where('drawDate', '==', configuracion.fecha_sorteo).get();
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
        console.error('Error al generar o enviar el reporte de ventas periódico por correo:', emailError);
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
app.get('/api/configuracion', (req, res) => {
    // Usa la caché en memoria. Se asume que `configuracion` está actualizada por `loadInitialData`
    // y por cualquier endpoint que la modifique.
    const configToSend = { ...configuracion };
    delete configToSend.mail_config; // No enviar credenciales sensibles
    res.json(configToSend);
});

// Actualizar configuración (Cambiado de POST a PUT)
app.put('/api/configuracion', async (req, res) => {
    const newConfig = req.body;
    try {
        // Leer la configuración más reciente de Firestore para asegurar consistencia
        let currentConfig = await readFirestoreDoc('app_config', 'main_config');
        if (!currentConfig) {
            return res.status(500).json({ message: 'Error: Configuración no encontrada en la base de datos.' });
        }

        // Fusionar solo los campos permitidos y existentes
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

        await writeFirestoreDoc('app_config', 'main_config', currentConfig);
        configuracion = currentConfig; // Actualizar la caché en memoria
        res.json({ message: 'Configuración actualizada con éxito', configuracion: configuracion });
    } catch (error) {
        console.error('Error al actualizar configuración en Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});


// Obtener estado de los números (AHORA LEE DIRECTAMENTE DE FIRESTORE)
app.get('/api/numeros', async (req, res) => {
    // Para asegurar la información más reciente, leer directamente de Firestore.
    // La caché 'numeros' ya no se carga completamente al inicio.
    try {
        const numbersSnapshot = await db.collection('raffle_numbers').get();
        const currentNumerosFirestore = numbersSnapshot.docs.map(doc => doc.data());
        // Opcional: actualizar la caché 'numeros' aquí si se va a usar en otras partes del backend
        // numeros = currentNumerosFirestore;
        console.log('DEBUG_BACKEND: Recibida solicitud GET /api/numeros. Enviando estado actual de numeros desde Firestore.');
        res.json(currentNumerosFirestore);
    } catch (error) {
        console.error('Error al obtener números desde Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.', error: error.message });
    }
});

// Actualizar estado de los números (usado internamente o por admin)
app.post('/api/numeros', async (req, res) => {
    const updatedNumbers = req.body; // Se espera el array completo de números
    try {
        const batch = db.batch();
        updatedNumbers.forEach(num => {
            const numRef = db.collection('raffle_numbers').doc(num.numero); // Usar el número como ID del documento
            batch.set(numRef, num, { merge: true }); // Merge para no sobrescribir si hay campos adicionales
        });
        await batch.commit();
        // Si se actualizan, la caché 'numeros' en memoria se actualiza.
        // Esto es útil si otras operaciones inmediatas en el mismo servidor necesitan el estado actualizado.
        numeros = updatedNumbers;
        console.log('DEBUG_BACKEND: Números actualizados en Firestore y en caché.');
        res.json({ message: 'Números actualizados con éxito.' });
    } catch (error) {
        console.error('Error al actualizar números en Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar números.' });
    }
});

// Ruta para obtener ventas (ahora siempre desde Firestore)
app.get('/api/ventas', async (req, res) => {
    try {
        // Para el panel de administración, siempre leer la última versión de ventas directamente de Firestore
        const currentVentas = await readFirestoreCollection('sales');
        // No se actualiza una variable global 'ventas' aquí, ya que no se usa como caché persistente.
        console.log('Enviando ventas al frontend desde Firestore:', currentVentas.length, 'ventas.');
        res.status(200).json(currentVentas);
    } catch (error) {
        console.error('Error al obtener ventas desde Firestore:', error);
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

    // Leer la configuración más reciente directamente de Firestore para la operación de compra
    const currentConfig = await readFirestoreDoc('app_config', 'main_config');
    if (!currentConfig) {
        return res.status(500).json({ message: 'Error: Configuración de la aplicación no disponible.' });
    }
    configuracion = currentConfig; // Actualizar la caché global `configuracion`

    // --- OPTIMIZACIÓN CLAVE AQUÍ: Leer solo los números seleccionados ---
    // Esto es CRÍTICO para asegurar la consistencia y evitar que se vendan números ya comprados.
    const selectedNumbersSnapshot = await db.collection('raffle_numbers')
                                            .where('numero', 'in', numerosSeleccionados)
                                            .get();
    const currentSelectedNumbersFirestore = selectedNumbersSnapshot.docs.map(doc => doc.data());

    // Verificar si la página está bloqueada
    if (configuracion.pagina_bloqueada) {
        console.warn('DEBUG_BACKEND: Página bloqueada, denegando compra.');
        return res.status(403).json({ message: 'La página está bloqueada para nuevas compras en este momento.' });
    }

    try {
        // Verificar si los números ya están comprados (usando solo los números seleccionados de Firestore)
        const conflictos = numerosSeleccionados.filter(n =>
            currentSelectedNumbersFirestore.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (conflictos.length > 0) {
            console.warn(`DEBUG_BACKEND: Conflicto de números: ${conflictos.join(', ')} ya comprados.`);
            return res.status(409).json({ message: `Los números ${conflictos.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        // Preparar batch para actualizar números en Firestore
        const numbersBatch = db.batch();
        numerosSeleccionados.forEach(numSel => {
            const numRef = db.collection('raffle_numbers').doc(numSel); // Usar el número como ID del documento
            numbersBatch.update(numRef, {
                comprado: true,
                originalDrawNumber: configuracion.numero_sorteo_correlativo
            });
            // Actualizar también la caché en memoria 'numeros' si se usa en otras partes del backend
            // Aunque no se carga al inicio, se puede mantener consistente con las escrituras.
            const numObjInCache = numeros.find(n => n.numero === numSel);
            if (numObjInCache) {
                numObjInCache.comprado = true;
                numObjInCache.originalDrawNumber = configuracion.numero_sorteo_correlativo;
            } else {
                // Si el número no estaba en la caché (porque no se cargó al inicio), añadirlo.
                numeros.push({ numero: numSel, comprado: true, originalDrawNumber: configuracion.numero_sorteo_correlativo });
            }
        });
        await numbersBatch.commit();
        console.log('DEBUG_BACKEND: Números actualizados en Firestore y en caché (solo los comprados).');


        const now = moment().tz("America/Caracas");
        configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
        const numeroTicket = configuracion.ultimo_numero_ticket.toString().padStart(5, '0');

        const nuevaVenta = {
            id: Date.now(), // Usar un timestamp como ID inicial para el frontend, Firestore generará su propio ID de documento
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

        // Guardar la nueva venta en Firestore
        const docRef = await db.collection('sales').add(nuevaVenta);
        nuevaVenta.firestoreId = docRef.id; // Añadir el ID de Firestore al objeto en memoria
        console.log('DEBUG_BACKEND: Venta guardada en Firestore con ID:', docRef.id);

        // Actualizar la configuración en Firestore (para ultimo_numero_ticket)
        await writeFirestoreDoc('app_config', 'main_config', {
            ultimo_numero_ticket: configuracion.ultimo_numero_ticket
        });
        console.log('DEBUG_BACKEND: Configuración (ultimo_numero_ticket) actualizada en Firestore.');

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });
        console.log('DEBUG_BACKEND: Respuesta de compra enviada al frontend.');

        const whatsappMessageIndividual = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${configuracion.fecha_sorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;
        await sendWhatsappNotification(whatsappMessageIndividual);
        console.log('DEBUG_BACKEND: Proceso de compra en backend finalizado.');

        // Lógica para Notificación de Ventas por Umbral (Resumen)
        try {
            // Recargar la configuración para el contador más reciente (siempre desde Firestore para esta lógica)
            const latestConfig = await readFirestoreDoc('app_config', 'main_config');
            configuracion = latestConfig; // Actualizar caché global

            const salesSnapshot = await db.collection('sales').where('drawDate', '==', configuracion.fecha_sorteo).get();
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
                await writeFirestoreDoc('app_config', 'main_config', {
                    last_sales_notification_count: currentMultiple * notificationThreshold
                });
                console.log(`[WhatsApp Notificación Resumen] Contador 'last_sales_notification_count' actualizado a ${currentMultiple * notificationThreshold} en Firestore.`);
            } else {
                console.log(`[WhatsApp Notificación Resumen Check] Ventas actuales (${currentTotalSales}) no han cruzado un nuevo múltiplo del umbral (${notificationThreshold}). Último contador notificado: ${prevNotifiedCount}. No se envió notificación de resumen.`);
            }

        } catch (notificationError) {
            console.error('Error durante la verificación de notificación de ventas por umbral:', notificationError);
        }

    } catch (error) {
        console.error('ERROR_BACKEND: Error al procesar la compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});

// Subir comprobante de pago
app.post('/api/upload-comprobante/:ventaId', async (req, res) => {
    const ventaId = parseInt(req.params.ventaId); // Este es el ID timestamp de la venta, usado para buscar
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se subió ningún archivo.' });
    }

    const comprobanteFile = req.files.comprobante;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (!allowedTypes.includes(comprobanteFile.mimetype)) {
        return res.status(400).json({ message: 'Tipo de archivo no permitido. Solo se aceptan imágenes (JPG, PNG, GIF) y PDF.' });
    }

    // Buscar la venta en Firestore por el ID original (timestamp)
    const salesSnapshot = await db.collection('sales').where('id', '==', ventaId).limit(1).get();
    if (salesSnapshot.empty) {
        return res.status(404).json({ message: 'Venta no encontrada.' });
    }
    const ventaDoc = salesSnapshot.docs[0];
    const ventaData = ventaDoc.data();
    const firestoreVentaId = ventaDoc.id; // Obtener el ID de Firestore del documento

    const now = moment().tz("America/Caracas");
    const timestamp = now.format('YYYYMMDD_HHmmss');
    const originalExtension = path.extname(comprobanteFile.name);
    const fileName = `comprobante_${ventaId}_${timestamp}${originalExtension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    try {
        await comprobanteFile.mv(filePath);

        // Actualiza la URL del voucher en la venta en Firestore
        await writeFirestoreDoc('sales', firestoreVentaId, { voucherURL: `/uploads/${fileName}` });
        console.log(`Voucher URL actualizado en Firestore para venta ${firestoreVentaId}.`);

        // Envío de correo electrónico con el comprobante adjunto
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
        console.error('Error al subir el comprobante:', error);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.', error: error.message });
    }
});

// Servir archivos subidos estáticamente
app.use('/uploads', express.static(UPLOADS_DIR));


// Endpoint para obtener horarios de Zulia (y Chance)
app.get('/api/horarios-zulia', (req, res) => {
    // Usa la caché en memoria.
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
        let currentHorarios = await readFirestoreDoc('lottery_times', 'zulia_chance');
        if (!currentHorarios) currentHorarios = { zulia: [], chance: [] };
        currentHorarios[tipo] = horarios;
        await writeFirestoreDoc('lottery_times', 'zulia_chance', currentHorarios);
        horariosZulia = currentHorarios; // Actualizar caché
        res.json({ message: `Horarios de ${tipo} actualizados con éxito.`, horarios: horariosZulia[tipo] });
    } catch (error) {
        console.error(`Error al actualizar horarios de ${tipo} en Firestore:`, error);
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
        const resultsSnapshot = await db.collection('draw_results')
                                      .where('fecha', '==', fecha)
                                      .where('tipoLoteria', '==', 'zulia')
                                      .get();
        const resultsForDateAndZulia = resultsSnapshot.docs.map(doc => doc.data());

        res.status(200).json(resultsForDateAndZulia);
    }
    catch (error) {
        console.error('Error al obtener resultados de Zulia desde Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de Zulia.', error: error.message });
    }
});


// Endpoint para obtener los últimos resultados del sorteo (ahora siempre desde Firestore)
app.get('/api/resultados-sorteo', async (req, res) => {
    try {
        // Leer directamente de Firestore, ya no se usa la caché global 'resultadosSorteo' para GETs
        const currentResultados = await readFirestoreCollection('draw_results');
        console.log('Enviando resultados de sorteo al frontend desde Firestore:', currentResultados.length, 'resultados.');
        res.status(200).json(currentResultados);
    } catch (error) {
        console.error('Error al obtener resultados de sorteo desde Firestore:', error);
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
        // Buscar si ya existe un resultado para esta fecha y tipo de lotería
        const existingResultsSnapshot = await db.collection('draw_results')
                                                .where('fecha', '==', fecha)
                                                .where('tipoLoteria', '==', tipoLoteria)
                                                .limit(1)
                                                .get();

        let docId;
        if (!existingResultsSnapshot.empty) {
            docId = existingResultsSnapshot.docs[0].id;
            await writeFirestoreDoc('draw_results', docId, {
                resultados: resultadosPorHora,
                ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
            });
        } else {
            docId = await addFirestoreDoc('draw_results', {
                fecha,
                tipoLoteria,
                resultados: resultadosPorHora,
                ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
            });
        }

        // No es necesario actualizar la caché global 'resultadosSorteo' aquí,
        // ya que el GET ahora lee directamente de Firestore.

        if (fecha === currentDay && tipoLoteria === 'zulia') {
            await writeFirestoreDoc('app_config', 'main_config', { ultima_fecha_resultados_zulia: fecha });
            configuracion.ultima_fecha_resultados_zulia = fecha; // Actualizar caché de config
        }

        res.status(200).json({ message: 'Resultados de sorteo guardados/actualizados con éxito.' });
    } catch (error) {
        console.error('Error al guardar/actualizar resultados de sorteo en Firestore:', error);
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
        { header: 'ID Interno Venta', key: 'id', width: 20 }, // Este es el ID timestamp
        { header: 'ID Firestore', key: 'firestoreId', width: 25 }, // Nuevo: ID de Firestore
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
        // console.log(`[DEBUG_EXCEL] Procesando venta #${index}:`, JSON.stringify(venta, null, 2)); // Descomentar para depurar cada venta
        worksheet.addRow({
            id: venta.id,
            firestoreId: venta.firestoreId || '', // Asegurar que firestoreId se muestre
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

app.post('/api/corte-ventas', async (req, res) => {
    console.log('[DEBUG_CORTE_VENTAS] Iniciando corte de ventas...');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const todayFormatted = now.format('YYYY-MM-DD');

        // Recargar configuración para asegurar los datos más recientes desde Firestore
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible.');
        }
        console.log('[DEBUG_CORTE_VENTAS] Configuración actual (desde Firestore):', JSON.stringify(configuracion, null, 2));

        // Obtener ventas directamente de Firestore para la fecha del sorteo actual
        const salesSnapshot = await db.collection('sales')
                                      .where('drawDate', '==', configuracion.fecha_sorteo)
                                      .get();
        const ventasDelDia = salesSnapshot.docs
            .map(doc => ({ firestoreId: doc.id, ...doc.data() })) // Incluir firestoreId para el reporte
            .filter(venta => venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente');

        console.log(`[DEBUG_CORTE_VENTAS] Ventas del día (${configuracion.fecha_sorteo}, Confirmadas/Pendientes) desde Firestore: ${ventasDelDia.length} items.`);
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

        // Recargar configuración y horarios para asegurar que estén al día para la lógica de reseteo
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        horariosZulia = await readFirestoreDoc('lottery_times', 'zulia_chance');

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
            // Leer los números de Firestore para liberar solo los que cumplen la condición
            const numbersToLiberateSnapshot = await db.collection('raffle_numbers')
                                                      .where('comprado', '==', true)
                                                      .where('originalDrawNumber', '<', currentDrawCorrelativo - 1) // Liberar si originalDrawNumber es al menos 2 sorteos atrás
                                                      .get();
            const batch = db.batch();
            let changedCount = 0;

            numbersToLiberateSnapshot.docs.forEach(doc => {
                const numRef = db.collection('raffle_numbers').doc(doc.id);
                batch.update(numRef, { comprado: false, originalDrawNumber: null });
                changedCount++;
                console.log(`Número ${doc.id} liberado en Firestore. Comprado originalmente para sorteo ${doc.data().originalDrawNumber}, ahora en sorteo ${currentDrawCorrelativo}.`);
            });

            if (changedCount > 0) {
                await batch.commit();
                // No es necesario recargar la caché 'numeros' global aquí, ya que se lee por demanda.
                console.log(`Se liberaron ${changedCount} números antiguos en Firestore.`);
            } else {
                console.log('No hay números antiguos para liberar en Firestore en este momento.');
            }
        }

        res.status(200).json({ message: message });

    } catch (error) {
        console.error('Error al realizar Corte de Ventas en Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar Corte de Ventas.', error: error.message });
    }
});


// --- RUTAS PARA PREMIOS ---

app.get('/api/premios', (req, res) => {
    const { fecha } = req.query;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Se requiere una fecha válida (YYYY-MM-DD) para obtener los premios.' });
    }

    const fechaFormateada = moment.tz(fecha, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    // Usa la caché en memoria para premios
    const premiosDelDia = premios[fechaFormateada] || {};

    const premiosParaFrontend = {
        fechaSorteo: fechaFormateada,
        sorteo12PM: premiosDelDia.sorteo12PM || { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
        sorteo3PM: premiosDelDia.sorteo3PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' },
        sorteo5PM: premiosDelDia.sorteo5PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' }
    };

    res.status(200).json(premiosParaFrontend);
});

app.post('/api/premios', async (req, res) => {
    const { fechaSorteo, sorteo12PM, sorteo3PM, sorteo5PM } = req.body;

    if (!fechaSorteo || !moment(fechaSorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'La fecha del sorteo (YYYY-MM-DD) es requerida y debe ser válida para guardar premios.' });
    }

    const fechaFormateada = moment.tz(fechaSorteo, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        let allPremios = await readFirestoreDoc('prizes', 'daily_prizes');
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

        await writeFirestoreDoc('prizes', 'daily_prizes', allPremios);
        premios = allPremios; // Actualizar caché
        console.log('Premios guardados/actualizados en Firestore y caché.');

        res.status(200).json({ message: 'Premios guardados/actualizados con éxito.', premiosGuardados: allPremios[fechaFormateada] });

    } catch (error) {
        console.error('Error al guardar premios en Firestore:', error);
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
        console.error('Error en la ruta /api/send-test-email:', error);
        res.status(500).json({ message: 'Error interno del servidor al enviar correo de prueba.', error: error.message });
    }
});

app.put('/api/tickets/validate/:id', async (req, res) => {
    const ventaId = parseInt(req.params.id); // Este es el ID timestamp de la venta
    const { validationStatus } = req.body;

    const estadosValidos = ['Confirmado', 'Falso', 'Pendiente'];
    if (!validationStatus || !estadosValidos.includes(validationStatus)) {
        return res.status(400).json({ message: 'Estado de validación inválido. Debe ser "Confirmado", "Falso" o "Pendiente".' });
    }

    try {
        // Buscar la venta en Firestore por el ID original (timestamp)
        const salesSnapshot = await db.collection('sales').where('id', '==', ventaId).limit(1).get();
        if (salesSnapshot.empty) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }
        const ventaDoc = salesSnapshot.docs[0];
        const ventaData = ventaDoc.data();
        const firestoreVentaId = ventaDoc.id;

        const oldValidationStatus = ventaData.validationStatus;

        // Actualizar el estado de validación en Firestore
        await writeFirestoreDoc('sales', firestoreVentaId, { validationStatus: validationStatus });

        // Si una venta se marca como "Falso", y antes no lo era, liberar los números asociados.
        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            const numerosAnulados = ventaData.numbers;
            if (numerosAnulados && numerosAnulados.length > 0) {
                const batch = db.batch();
                numerosAnulados.forEach(numAnulado => {
                    const numRef = db.collection('raffle_numbers').doc(numAnulado); // Usar el número como ID del documento
                    batch.update(numRef, { comprado: false, originalDrawNumber: null });
                });
                await batch.commit();
                // No es necesario recargar la caché 'numeros' global aquí, ya que se lee por demanda.
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} (marcada como Falsa) han sido puestos nuevamente disponibles en Firestore.`);
            }
        }

        // No se actualiza la caché global 'ventas' aquí, ya que el GET ahora lee directamente de Firestore.

        res.status(200).json({ message: `Estado de la venta ${ventaId} actualizado a "${validationStatus}" con éxito.`, venta: { id: ventaId, ...ventaData, validationStatus: validationStatus } });
    } catch (error) {
        console.error(`Error al actualizar el estado de la venta ${ventaId} en Firestore:`, error);
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
        // Exportar datos de Firestore a Excel y añadir al ZIP
        const collectionsToExport = ['app_config', 'raffle_numbers', 'sales', 'lottery_times', 'draw_results', 'prizes', 'winners'];

        for (const collectionName of collectionsToExport) {
            const snapshot = await db.collection(collectionName).get();
            const data = snapshot.docs.map(doc => ({ firestoreId: doc.id, ...doc.data() }));

            if (data.length > 0) {
                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet(collectionName);

                // Determinar columnas dinámicamente
                const allKeys = new Set();
                data.forEach(row => {
                    Object.keys(row).forEach(key => allKeys.add(key));
                });
                const columns = Array.from(allKeys).map(key => ({ header: key, key: key, width: 25 }));
                worksheet.columns = columns;

                worksheet.addRow(columns.map(col => col.header)); // Añadir encabezados
                data.forEach(row => {
                    const rowData = {};
                    columns.forEach(col => {
                        // Manejar arrays (ej. 'numbers') para que se muestren como strings separados por coma
                        if (Array.isArray(row[col.key])) {
                            rowData[col.key] = row[col.key].join(', ');
                        } else if (typeof row[col.key] === 'object' && row[col.key] !== null) {
                            // Convertir objetos anidados a JSON string
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
                console.log(`Colección ${collectionName} está vacía, no se generó Excel.`);
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
    const { ventaId } = req.body; // Este es el ID timestamp de la venta

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp.' });
    }

    try {
        const salesSnapshot = await db.collection('sales').where('id', '==', ventaId).limit(1).get();
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
        console.error('Error al generar el enlace de WhatsApp para el cliente:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});

// Endpoint para generar el enlace de WhatsApp para notificar pago falso
app.post('/api/generate-whatsapp-false-payment-link', async (req, res) => {
    const { ventaId } = req.body; // Este es el ID timestamp de la venta

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp para pago falso.' });
    }

    try {
        const salesSnapshot = await db.collection('sales').where('id', '==', ventaId).limit(1).get();
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
        console.error('Error al generar el enlace de WhatsApp para pago falso:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp para pago falso.', error: error.message });
    }
});

// Endpoint NUEVO: Para enviar notificación de ticket ganador vía WhatsApp
app.post('/api/notify-winner', async (req, res) => {
    const {
        ventaId, // Este es el ID timestamp de la venta
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
            `¡Felicidades, ${buyerName}! 🎉🥳🎉\n\n` +
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
        // Leer directamente de Firestore para asegurar los datos más recientes para este proceso crítico
        const allVentasSnapshot = await db.collection('sales').get();
        const allVentas = allVentasSnapshot.docs.map(doc => doc.data());

        const allResultadosSorteoSnapshot = await db.collection('draw_results').get();
        const allResultadosSorteo = allResultadosSorteoSnapshot.docs.map(doc => doc.data());

        const premiosDoc = await readFirestoreDoc('prizes', 'daily_prizes');
        const allPremios = premiosDoc || {};

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
                        if (r.hora.includes('12:45 PM')) { // Asumiendo que estos son los identificadores de hora en tus resultados
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
                    // Asegurarse de que `configuracion.tasa_dolar` esté actualizado
                    const currentConfig = await readFirestoreDoc('app_config', 'main_config');
                    configuracion = currentConfig; // Actualizar caché
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

        // Buscar si ya existe una entrada de ganadores para este sorteo
        const existingWinnersSnapshot = await db.collection('winners')
                                                .where('drawDate', '==', fecha)
                                                .where('drawNumber', '==', parseInt(numeroSorteo))
                                                .where('lotteryType', '==', tipoLoteria)
                                                .limit(1)
                                                .get();

        if (!existingWinnersSnapshot.empty) {
            const docId = existingWinnersSnapshot.docs[0].id;
            await writeFirestoreDoc('winners', docId, newWinnersEntry);
            console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} actualizados en Firestore.`);
        } else {
            await addFirestoreDoc('winners', newWinnersEntry);
            console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} añadidos a Firestore.`);
        }

        // No se actualiza la caché global 'ganadoresSorteos' aquí, ya que el GET ahora lee directamente de Firestore.
        res.status(200).json({ message: 'Ganadores procesados y guardados con éxito.', totalGanadores: ticketsGanadoresParaEsteSorteo.length });

    } catch (error) {
        console.error('Error al procesar y guardar tickets ganadores en Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar y guardar tickets ganadores.', error: error.message });
    }
});


// GET /api/tickets/ganadores (ahora siempre desde Firestore)
app.get('/api/tickets/ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.query;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos.' });
    }

    try {
        // Leer directamente de Firestore, ya no se usa la caché global 'ganadoresSorteos' para GETs
        const winnersSnapshot = await db.collection('winners')
                                        .where('drawDate', '==', fecha)
                                        .where('drawNumber', '==', parseInt(numeroSorteo))
                                        .where('lotteryType', '==', tipoLoteria)
                                        .limit(1) // Solo necesitamos una entrada por sorteo
                                        .get();

        if (!winnersSnapshot.empty) {
            const foundEntry = winnersSnapshot.docs[0].data();
            res.status(200).json({ ganadores: foundEntry.winners });
        } else {
            res.status(200).json({ ganadores: [], message: 'No se encontraron tickets ganadores procesados para esta consulta.' });
        }
    } catch (error) {
        console.error('Error al obtener ganadores desde Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ganadores.', error: error.message });
    }
});

// Función para liberar números que ya excedieron la reserva de 2 sorteos
async function liberateOldReservedNumbers(currentDrawCorrelative) {
    console.log(`[liberateOldReservedNumbers] Revisando números para liberar (correlativo actual: ${currentDrawCorrelative})...`);
    
    // Leer los números más recientes de Firestore para asegurar la precisión
    const numbersToLiberateSnapshot = await db.collection('raffle_numbers')
                                              .where('comprado', '==', true)
                                              .where('originalDrawNumber', '<', currentDrawCorrelative - 1) // Liberar si originalDrawNumber es al menos 2 sorteos atrás
                                              .get();
    const batch = db.batch();
    let changedCount = 0;

    numbersToLiberateSnapshot.docs.forEach(doc => {
        const numRef = db.collection('raffle_numbers').doc(doc.id); // El ID del documento es el número
        batch.update(numRef, { comprado: false, originalDrawNumber: null });
        changedCount++;
        console.log(`Número ${doc.id} liberado en Firestore. Comprado originalmente para sorteo ${doc.data().originalDrawNumber}, ahora en sorteo ${currentDrawCorrelative}.`);
    });

    if (changedCount > 0) {
        await batch.commit();
        // No es necesario recargar la caché 'numeros' global aquí, ya que se lee por demanda.
        console.log(`[liberateOldReservedNumbers] Se liberaron ${changedCount} números antiguos en Firestore.`);
    } else {
        console.log('[liberateOldReservedNumbers] No hay números antiguos para liberar en Firestore en este momento.');
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
    await writeFirestoreDoc('app_config', 'main_config', updatedConfig);
    configuracion = { ...configuracion, ...updatedConfig }; // Actualizar la caché en memoria
    console.log(`Configuración avanzada en Firestore para el siguiente sorteo: Fecha ${configuracion.fecha_sorteo}, Correlativo ${configuracion.numero_sorteo_correlativo}.`);
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
        // Asegura que la configuración esté actualizada desde Firestore para esta lógica crítica
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible para evaluación.');
        }
        let currentConfig = configuracion; // Usar la caché actualizada

        const currentDrawDateStr = currentConfig.fecha_sorteo;

        // Obtener ventas directamente de Firestore para la fecha del sorteo actual
        const salesSnapshot = await db.collection('sales')
                                      .where('drawDate', '==', currentDrawDateStr)
                                      .get();
        const soldTicketsForCurrentDraw = salesSnapshot.docs
            .map(doc => ({ firestoreId: doc.id, ...doc.data() })) // Incluir firestoreId
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

        const batch = db.batch(); // Crear un batch para actualizar múltiples ventas

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados en Firestore.`);

            soldTicketsForCurrentDraw.forEach(venta => {
                const ventaRef = db.collection('sales').doc(venta.firestoreId);
                batch.update(ventaRef, {
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
            // Actualizar configuración en Firestore
            await writeFirestoreDoc('app_config', 'main_config', {
                pagina_bloqueada: true,
                block_reason_message: "El sorteo ha sido ANULADO por bajo porcentaje de ventas. Tus tickets válidos han sido revalidados para el próximo sorteo. ¡Vuelve pronto!"
            });
            configuracion.pagina_bloqueada = true; // Actualizar caché
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
                const ventaRef = db.collection('sales').doc(venta.firestoreId);
                batch.update(ventaRef, {
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
            // Actualizar configuración en Firestore
            await writeFirestoreDoc('app_config', 'main_config', {
                pagina_bloqueada: true,
                block_reason_message: "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!"
            });
            configuracion.pagina_bloqueada = true; // Actualizar caché
            configuracion.block_reason_message = "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                currentConfig,
                `Reporte de Cierre del Sorteo ${currentDrawDateStr}`,
                'Reporte_Cierre'
            );
        }

        await batch.commit(); // Ejecutar todas las actualizaciones de ventas en un solo batch
        // No se actualiza la caché global 'ventas' aquí, ya que el GET ahora lee directamente de Firestore.
        console.log('[evaluateDrawStatusOnly] Estado de ventas actualizado en Firestore.');

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

        // La configuración ya se actualizó y guardó arriba.
        console.log('[evaluateDrawStatusOnly] Página bloqueada para nuevas compras con mensaje actualizado en Firestore.');

        return { success: true, message: message, evaluatedDate: currentDrawDateStr, salesPercentage: soldPercentage };

    } catch (error) {
        console.error('[evaluateDrawStatusOnly] ERROR durante la evaluación del sorteo en Firestore:', error.stack || error.message);
        return { success: false, message: `Error interno al evaluar estado de sorteo: ${error.message}` };
    }
}


// --- Lógica central para la verificación, anulación/cierre y AVANCE del sorteo (Cierre Manual) ---
async function cerrarSorteoManualmente(nowMoment) {
    console.log(`[cerrarSorteoManualmente] Iniciando cierre manual de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        // Asegura que `configuracion` esté actualizada desde Firestore para esta lógica crítica
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible para cierre manual.');
        }
        let currentConfig = configuracion; // Usar la caché actualizada
        
        const currentDrawDateStr = currentConfig.fecha_sorteo;
        const currentDrawCorrelativo = currentConfig.numero_sorteo_correlativo;

        // Step 1: Evaluate sales status (anular/cerrar sales)
        const evaluationResult = await evaluateDrawStatusOnly(nowMoment);
        if (!evaluationResult.success) {
            return evaluationResult;
        }

        // Step 2: Liberate numbers based on the *current* draw correlative
        await liberateOldReservedNumbers(currentDrawCorrelativo);


        // Step 3: Advance the configuration to the next day
        const nextDayDate = nowMoment.clone().add(1, 'days').format('YYYY-MM-DD');
        await advanceDrawConfiguration(currentConfig, nextDayDate);

        // La configuración en memoria (`configuracion`) ya está actualizada por `advanceDrawConfiguration`

        // Se envía una notificación de WhatsApp específica para el cierre manual
        const whatsappMessage = `*¡Sorteo Finalizado y Avanzado!* 🥳\n\nEl sorteo del *${evaluationResult.evaluatedDate}* ha sido finalizado. Ventas: *${evaluationResult.salesPercentage.toFixed(2)}%*.\n\nLa configuración ha avanzado al Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha *${configuracion.fecha_sorteo}*.`;
        await sendWhatsappNotification(whatsappMessage);

        // Si se desea un correo EXTRA de confirmación de AVANCE:
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
        console.error('[cerrarSorteoManualmente] ERROR durante el cierre manual del sorteo en Firestore:', error.stack || error.message);
        return { success: false, message: `Error interno: ${error.message}` };
    }
}


// --- ENDPOINT PARA CIERRE MANUAL DEL SORTEO (Full Close + Advance) ---
app.post('/api/cerrar-sorteo-manualmente', async (req, res) => {
    console.log('API: Recibida solicitud para cierre manual de sorteo.');
    try {
        // Asegura que `configuracion` esté actualizada desde Firestore para esta lógica crítica
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible para cierre manual.');
        }
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
        console.error('Error en la API de cierre manual de sorteo en Firestore:', error.stack || error.message);
        res.status(500).json({ message: 'Error interno del servidor al cerrar el sorteo manualmente.', error: error.message });
    }
});


// --- ENDPOINT PARA SUSPENDER SORTEO (Evaluate Sales Only) ---
// Este endpoint permite evaluar las ventas y marcar los tickets, sin avanzar la fecha del sorteo.
app.post('/api/suspender-sorteo', async (req, res) => {
    console.log('API: Recibida solicitud para suspender sorteo (evaluación de ventas).');
    try {
        // Carga los últimos datos de configuración desde Firestore para esta lógica crítica
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible para suspensión.');
        }
        const now = moment().tz(CARACAS_TIMEZONE);

        const result = await evaluateDrawStatusOnly(now); // Llama a la nueva función de solo evaluación

        if (result.success) {
            res.status(200).json({ message: result.message, evaluatedDate: result.evaluatedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de suspensión de sorteo en Firestore:', error.stack || error.message);
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
        // Asegura que la configuración esté actualizada para esta lógica crítica
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible para establecer fecha manual.');
        }
        let currentConfig = configuracion; // Usar la caché
        
        const oldDrawDate = currentConfig.fecha_sorteo;
        const oldDrawCorrelativo = currentConfig.numero_sorteo_correlativo; 

        // 1. Avanzar la configuración a la fecha manualmente establecida
        await advanceDrawConfiguration(currentConfig, newDrawDate);
        // `configuracion` (en memoria) ya está actualizada por `advanceDrawConfiguration`

        // 2. Liberar números reservados que ya no son válidos con el NUEVO correlativo.
        await liberateOldReservedNumbers(configuracion.numero_sorteo_correlativo);

        // Obtener ventas del sorteo ANTERIOR para el reporte Excel
        const salesForOldDrawSnapshot = await db.collection('sales')
                                                .where('drawDate', '==', oldDrawDate)
                                                .get();
        const salesForOldDraw = salesForOldDrawSnapshot.docs
            .map(doc => doc.data())
            .filter(venta => ['Confirmado', 'Pendiente', 'Cerrado por Suficiencia de Ventas', 'Anulado por bajo porcentaje'].includes(venta.validationStatus));


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            salesForOldDraw,
            { fecha_sorteo: oldDrawDate, numero_sorteo_correlativo: oldDrawCorrelativo }, // Pass old config for report context
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
        console.error('Error en la API de set-manual-draw-date en Firestore:', error.stack || error.message);
        res.status(500).json({ message: 'Error interno del servidor al establecer la fecha del sorteo manualmente.', error: error.stack || error.message });
    }
});


// NUEVO ENDPOINT: Notificación de ventas para desarrolladores
app.post('/api/developer-sales-notification', async (req, res) => {
    console.log('API: Recibida solicitud para notificación de ventas para desarrolladores.');
    try {
        // Asegura que la configuración esté al día desde Firestore para esta lógica crítica
        configuracion = await readFirestoreDoc('app_config', 'main_config');
        if (!configuracion) {
            throw new Error('Configuración de la aplicación no disponible para notificación de desarrolladores.');
        }
        const now = moment().tz(CARACAS_TIMEZONE);

        const currentDrawDateStr = configuracion.fecha_sorteo;
        const salesSnapshot = await db.collection('sales')
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
        console.error('Error al enviar notificación de ventas para desarrolladores desde Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al enviar notificación de ventas para desarrolladores.', error: error.message });
    }
});


// Endpoint para limpiar todos los datos (útil para reinicios de sorteo)
app.post('/api/admin/limpiar-datos', async (req, res) => {
    console.log('API: Recibida solicitud para limpiar todos los datos en Firestore.');
    try {
        const collectionsToClear = ['sales', 'raffle_numbers', 'draw_results', 'winners']; // No limpiar app_config ni lottery_times completamente, solo resetearlos

        for (const collectionName of collectionsToClear) {
            const snapshot = await db.collection(collectionName).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`Colección '${collectionName}' de Firestore limpiada.`);
        }

        // Reiniciar números a su estado inicial en Firestore
        const batchNumbers = db.batch();
        for (let i = 0; i < 1000; i++) {
            const numStr = i.toString().padStart(3, '0');
            const numRef = db.collection('raffle_numbers').doc(numStr);
            batchNumbers.set(numRef, { numero: numStr, comprado: false, originalDrawNumber: null });
        }
        await batchNumbers.commit();
        console.log('Números de rifa reiniciados en Firestore.');

        // Reiniciar configuración principal en Firestore
        // Primero, leer la configuración actual para mantener mail_config, whatsapp_numbers, etc.
        const currentConfig = await readFirestoreDoc('app_config', 'main_config');
        await writeFirestoreDoc('app_config', 'main_config', {
            "precio_ticket": 0.50,
            "tasa_dolar": 36.50,
            "fecha_sorteo": moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            "numero_sorteo_correlativo": 1,
            "ultimo_numero_ticket": 0,
            "pagina_bloqueada": false,
            "block_reason_message": "",
            // Mantener la configuración de correo, WhatsApp y email de reportes
            "mail_config": currentConfig.mail_config,
            "admin_whatsapp_numbers": currentConfig.admin_whatsapp_numbers,
            "last_sales_notification_count": 0,
            "sales_notification_threshold": currentConfig.sales_notification_threshold,
            "admin_email_for_reports": currentConfig.admin_email_for_reports,
            "ultima_fecha_resultados_zulia": null
        });
        console.log('Configuración principal reiniciada en Firestore.');

        // Reiniciar horarios (siempre deben existir)
        await writeFirestoreDoc('lottery_times', 'zulia_chance', {
            zulia: ["12:00 PM", "04:00 PM", "07:00 PM"],
            chance: ["01:00 PM", "05:00 PM", "08:00 PM"]
        });
        console.log('Horarios reiniciados en Firestore.');

        // Reiniciar premios (vacío)
        await writeFirestoreDoc('prizes', 'daily_prizes', {});
        console.log('Premios reiniciados en Firestore.');


        // Recargar solo las cachés que se cargan al inicio después de la limpieza
        await loadInitialData();

        res.status(200).json({ success: true, message: 'Todos los datos en Firestore (ventas, números, resultados, ganadores, premios) han sido limpiados y reiniciados.' });
    } catch (error) {
        console.error('Error al limpiar los datos en Firestore:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al limpiar los datos.' });
    }
});


// Tareas programadas (Cron Jobs)
// Se ejecutarán después de que el servidor se inicie y los datos se carguen
cron.schedule('15 12 * * *', async () => {
    console.log('CRON JOB: Ejecutando tarea programada para verificar ventas y posible anulación/cierre de sorteo.');
    const cronResult = await cerrarSorteoManualmente(moment().tz(CARACAS_TIMEZONE));
    console.log(`CRON JOB Resultado: ${cronResult.message}`);
}, {
    timezone: CARACAS_TIMEZONE
});

cron.schedule('*/55 * * * *', async () => {
    console.log('CRON JOB: Ejecutando tarea programada para enviar notificación de resumen de ventas por WhatsApp y Email.');
    await sendSalesSummaryNotifications();
});

// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => { // Asegura que los datos se carguen desde Firestore antes de configurar el mailer y escuchar
        configureMailer(); // Configura el mailer con la configuración cargada
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
        });
    });
}).catch(err => {
    console.error('Failed to initialize data and start server:', err);
    process.exit(1);
});
