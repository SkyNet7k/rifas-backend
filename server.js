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
                    "port": 587,
                    "secure": false,
                    "user": "tu_correo@gmail.com", // Placeholder
                    "pass": "tu_contraseña_o_app_password",   // Placeholder
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
        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE); // Leer como objeto
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
    if (configuracion.mail_config && configuracion.mail_config.user && configuracion.mail_config.pass) {
        transporter = nodemailer.createTransport({
            host: configuracion.mail_config.host,
            port: configuracion.mail_config.port,
            secure: configuracion.mail_config.secure,
            auth: {
                user: configuracion.mail_config.user,
                pass: configuracion.mail_config.pass
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
app.put('/api/configuracion', async (req, res) => { // CAMBIO CLAVE: Aquí cambiamos de app.post a app.put
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
            // Si el valor enviado no es un array, lo convertimos en uno que contenga solo ese valor.
            // Esto es útil si el frontend envía un string.
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

// Obtener ventas
app.get('/api/ventas', (req, res) => {
    res.json(ventas);
});

// *** INICIO DE LA SOLUCIÓN: MANEJAR SOLICITUDES GET INESPERADAS A /api/compra ***
app.get('/api/compra', (req, res) => {
    // Esta ruta no está diseñada para manejar solicitudes GET para la compra de tickets.
    // La compra se realiza mediante una solicitud POST a /api/comprar.
    res.status(404).json({
        message: 'Esta ruta no soporta solicitudes GET. Para realizar una una compra, utiliza el método POST en /api/comprar.',
        hint: 'Si estás intentando obtener información de ventas, usa la ruta GET /api/ventas.'
    });
});
// *** FIN DE LA SOLUCIÓN ***


// Ruta para la compra de tickets
app.post('/api/comprar', async (req, res) => {
    const { numerosSeleccionados, valorUsd, valorBs, metodoPago, referenciaPago, comprador, telefono, fechaSorteo, horaSorteo } = req.body;

    if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !valorUsd || !valorBs || !metodoPago || !comprador || !telefono || !fechaSorteo || !horaSorteo) {
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra.' });
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
            drawDate: fechaSorteo, // Fecha del sorteo (YYYY-MM-DD)
            drawNumber: configuracion.numero_sorteo_correlativo, // Número correlativo del sorteo
            ticketNumber: numeroTicket,
            buyerName: comprador,
            buyerPhone: telefono,
            numbers: numerosSeleccionados, // Renombrado a 'numbers' para consistencia con frontend
            valueUSD: parseFloat(valorUsd), // Renombrado a 'valueUSD'
            valueBs: parseFloat(valorBs), // Renombrado a 'valueBs'
            paymentMethod: metodoPago,
            paymentReference: referenciaPago,
            voucherURL: null, // Se llenará si se sube un comprobante
            validationStatus: 'Pendiente' // Renombrado a 'validationStatus'
        };

        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);
        await writeJsonFile(NUMEROS_FILE, currentNumeros); // Guardar los números actualizados en el archivo
        numeros = currentNumeros; // CAMBIO CLAVE: Actualizar la variable global 'numeros' en memoria
        await writeJsonFile(CONFIG_FILE, configuracion); // Guardar el config con el nuevo número de ticket

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });

        // Enviar notificación a WhatsApp
        const whatsappMessage = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${fechaSorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;

        if (configuracion.admin_whatsapp_numbers && configuracion.admin_whatsapp_numbers.length > 0) {
            configuracion.admin_whatsapp_numbers.forEach(adminNumber => {
                const whatsappUrl = `https://api.whatsapp.com/send?phone=${adminNumber}&text=${whatsappMessage}`;
                console.log(`URL de WhatsApp para ${adminNumber}: ${whatsappUrl}`);
                // En un entorno real, no abrirías la URL directamente aquí.
                // Esto es solo para depuración o si tienes un servicio que pueda enviar el mensaje directamente.
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
        // Ahora se usa la función sendEmail con la configuración admin_email_for_reports que puede ser un array
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const subject = `Nuevo Comprobante de Pago para Venta #${ventas[ventaIndex].ticketNumber}`; // Usar ticketNumber
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
    // Se devuelve el objeto completo de horarios que contiene 'zulia' y 'chance'
    res.json(horariosZulia);
});

// Endpoint para actualizar horarios de Zulia (y Chance)
// Se modifica para aceptar el tipo de lotería en la ruta o cuerpo
app.post('/api/horarios', async (req, res) => {
    const { tipo, horarios } = req.body; // 'tipo' puede ser 'zulia' o 'chance'
    if (!tipo || (tipo !== 'zulia' && tipo !== 'chance')) {
        return res.status(400).json({ message: 'Tipo de lotería inválido. Debe ser "zulia" o "chance".' });
    }
    // ELIMINADA: Validación de formato de horarios. Ahora acepta cualquier string en el array.
    // if (!Array.isArray(horarios) || !horarios.every(h => typeof h === 'string' && h.match(/^\d{2}:\d{2} (AM|PM)$/))) {
    //     return res.status(400).json({ message: 'Formato de horarios inválido. Espera un array de strings como ["HH:MM AM/PM"].' });
    // }
    // Solo verificar que sea un array de strings.
    if (!Array.isArray(horarios) || !horarios.every(h => typeof h === 'string')) {
        return res.status(400).json({ message: 'Formato de horarios inválido. Espera un array de strings.' });
    }
    try {
        horariosZulia[tipo] = horarios; // Actualiza el array específico dentro del objeto horariosZulia
        await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        res.json({ message: `Horarios de ${tipo} actualizados con éxito.`, horarios: horariosZulia[tipo] });
    } catch (error) {
        console.error(`Error al actualizar horarios de ${tipo}:`, error);
        res.status(500).json({ message: `Error interno del servidor al actualizar horarios de ${tipo}.` });
    }
});

// NUEVA RUTA: Endpoint para obtener los resultados de Zulia por fecha
// Esta ruta es la que el frontend está llamando con un parámetro 'fecha'
app.get('/api/resultados-zulia', async (req, res) => {
    const { fecha } = req.query; // Obtener el parámetro de fecha de la consulta

    if (!fecha) {
        // Si no se proporciona fecha, se devuelve un error 400
        return res.status(400).json({ message: 'Se requiere el parámetro "fecha" para consultar resultados de Zulia.' });
    }

    try {
        const allResultados = await readJsonFile(RESULTADOS_SORTEO_FILE);
        // Filtramos por la fecha proporcionada y por tipoLoteria 'zulia'
        const resultsForDateAndZulia = allResultados.filter(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === 'zulia'
        );

        // Se devuelve un array de resultados. Si no hay, será un array vacío.
        // El frontend ya busca el `find(r => r.fecha === fecha)` después.
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
    const { fecha, tipoLoteria, resultadosPorHora } = req.body; // resultadosPorHora es un array de { hora, tripleA, tripleB }

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
            // Actualizar resultados existentes
            resultadosSorteo[existingEntryIndex].resultados = resultadosPorHora;
            resultadosSorteo[existingEntryIndex].ultimaActualizacion = now.format('YYYY-MM-DD HH:mm:ss');
        } else {
            // Añadir nuevos resultados
            resultadosSorteo.push({
                fecha,
                tipoLoteria,
                resultados: resultadosPorHora,
                ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
            });
        }
        await writeJsonFile(RESULTADOS_SORTEO_FILE, resultadosSorteo);

        // Actualizar ultima_fecha_resultados_zulia en la configuración si es el día actual y tipo Zulia
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

        // Filtrar las ventas para obtener las del día actual (para el reporte)
        const ventasDelDia = ventas.filter(venta =>
            moment(venta.purchaseDate).tz("America/Caracas").format('YYYY-MM-DD') === todayFormatted
        );

        // Sumar los valores en USD y Bs
        const totalVentasUSD = ventasDelDia.reduce((sum, venta) => sum + venta.valueUSD, 0);
        const totalVentasBs = ventasDelDia.reduce((sum, venta) => sum + venta.valueBs, 0);

        // Generar un reporte en Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Corte de Ventas');

        // Añadir encabezados
        worksheet.columns = [
            { header: 'Campo', key: 'field', width: 20 },
            { header: 'Valor', key: 'value', width: 30 }
        ];

        // Añadir datos generales del corte
        worksheet.addRow({ field: 'Fecha del Corte', value: now.format('YYYY-MM-DD HH:mm:ss') });
        worksheet.addRow({ field: 'Total Ventas USD', value: totalVentasUSD.toFixed(2) });
        worksheet.addRow({ field: 'Total Ventas Bs', value: totalVentasBs.toFixed(2) });
        worksheet.addRow({ field: 'Número de Ventas', value: ventasDelDia.length });

        // Añadir una sección para las ventas detalladas
        worksheet.addRow({}); // Fila vacía para espacio
        worksheet.addRow({ field: 'Detalle de Ventas del Día' });
        worksheet.addRow({}); // Fila vacía para espacio

        // Encabezados de la tabla de ventas
        const ventasHeaders = [
            { header: 'Fecha/Hora Compra', key: 'purchaseDate', width: 20 },
            { header: 'Fecha Sorteo', key: 'drawDate', width: 15 },
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
        worksheet.addRow(ventasHeaders.map(h => h.header)); // Añade los nombres de las columnas

        // Añadir las filas de ventas
        ventasDelDia.forEach(venta => {
            worksheet.addRow({
                purchaseDate: moment(venta.purchaseDate).tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
                drawDate: venta.drawDate,
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

        // Guardar el archivo Excel
        const excelFileName = `Corte_Ventas_${todayFormatted}.xlsx`;
        const excelFilePath = path.join(REPORTS_DIR, excelFileName);
        await workbook.xlsx.writeFile(excelFilePath);

        // Envío de correo electrónico con el reporte adjunto
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


        // Reiniciar los números a "no comprados"
        numeros = numeros.map(n => ({ ...n, comprado: false }));
        // Se ELIMINA la línea que filtraba las ventas para mantener el historial completo.
        // ventas = ventas.filter(venta => moment(venta.fecha_hora_compra).tz("America/Caracas").format('YYYY-MM-DD') !== todayFormatted);

        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(VENTAS_FILE, ventas); // Guardar el archivo de ventas SIN FILTRAR

        res.status(200).json({ message: 'Corte de ventas realizado con éxito y números reiniciados. El historial de ventas se ha mantenido.' });

    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar corte de ventas.', error: error.message });
    }
});


// Tarea programada para reinicio diario de números y actualización de fecha de sorteo
cron.schedule('0 0 * * *', async () => { // Se ejecuta todos los días a las 00:00 (medianoche)
    console.log('Ejecutando tarea programada: reinicio de números y actualización de fecha de sorteo...');
    try {
        const now = moment().tz("America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');
        const currentDrawDate = configuracion.fecha_sorteo;

        // Comprobar si la fecha de sorteo es anterior a hoy
        if (moment(currentDrawDate).isBefore(todayFormatted, 'day')) {
            console.log(`La fecha de sorteo (${currentDrawDate}) es anterior a hoy (${todayFormatted}). Reiniciando números y actualizando fecha.`);
            // Reiniciar los números
            numeros = numeros.map(n => ({ ...n, comprado: false }));
            await writeJsonFile(NUMEROS_FILE, numeros);
            console.log('Números reiniciados a no comprados.');

            // Reiniciar ventas para la fecha anterior (opcional, si quieres mantener un historial de ventas completas y luego hacer cortes)
            // Si el corte de ventas ya limpia ventas del día, esto no sería necesario aquí a medianoche.
            // ventas = ventas.filter(venta => moment(venta.fecha_hora_compra).tz("America/Caracas").format('YYYY-MM-DD') !== currentDrawDate);
            // await writeJsonFile(VENTAS_FILE, ventas);
            // console.log(`Ventas del día ${currentDrawDate} limpiadas.`);

            // Actualizar la fecha del próximo sorteo a mañana y el correlativo
            configuracion.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD');
            configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;
            configuracion.ultimo_numero_ticket = 0; // Reiniciar el último número de ticket usado
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
    const { fecha } = req.query; // Espera un parámetro de consulta 'fecha' (ej. '2025-06-03')

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Se requiere una fecha válida (YYYY-MM-DD) para obtener los premios.' });
    }

    // Formatear la fecha para que coincida con la clave en el JSON, asegurando zona horaria
    const fechaFormateada = moment.tz(fecha, "America/Caracas").format('YYYY-MM-DD');

    try {
        const allPremios = await readJsonFile(PREMIOS_FILE);
        // Devuelve los premios del día o un objeto vacío si no existen
        const premiosDelDia = allPremios[fechaFormateada] || {}; // Si no hay premios para la fecha, es un objeto vacío

        // Rellenar con valores por defecto si no hay premios para esa fecha o si algún sorteo está incompleto
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

    // Formatear la fecha para que coincida con la clave en el JSON, asegurando zona horaria
    const fechaFormateada = moment.tz(fechaSorteo, "America/Caracas").format('YYYY-MM-DD');

    try {
        const allPremios = await readJsonFile(PREMIOS_FILE);

        // Actualizar o crear la entrada para la fecha específica
        // Nos aseguramos de que solo se guarden Triple A y Triple B, ignorando Triple C si se envía.
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

// NUEVA RUTA: Ruta POST para enviar un correo de prueba
app.post('/api/send-test-email', async (req, res) => {
    try {
        const { to, subject, html } = req.body;

        if (!to || !subject || !html) {
            return res.status(400).json({ message: 'Faltan parámetros: "to", "subject" y "html" son obligatorios.' });
        }

        const emailSent = await sendEmail(to, subject, html); // 'to' puede ser un string aquí, la función sendEmail lo maneja

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


// NUEVA RUTA: Endpoint para actualizar el estado de validación de una venta
app.put('/api/tickets/validate/:id', async (req, res) => { // CAMBIO DE RUTA: /api/ventas/:id/validar a /api/tickets/validate/:id para coincidir con el frontend
    const ventaId = parseInt(req.params.id); // Asegúrate de que el ID sea un entero
    const { validationStatus } = req.body; // Renombrado de estado_validacion a validationStatus

    // Validar el estado de validación recibido
    const estadosValidos = ['Confirmado', 'Falso', 'Pendiente'];
    if (!validationStatus || !estadosValidos.includes(validationStatus)) {
        return res.status(400).json({ message: 'Estado de validación inválido. Debe ser "Confirmado", "Falso" o "Pendiente".' });
    }

    try {
        const ventaIndex = ventas.findIndex(v => v.id === ventaId);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        // Obtener el estado de validación actual antes de actualizar
        const oldValidationStatus = ventas[ventaIndex].validationStatus; // Renombrado

        // Actualizar el campo validationStatus
        ventas[ventaIndex].validationStatus = validationStatus; // Renombrado

        // Si el estado cambia a 'Falso' y no era 'Falso' antes, anular la venta y liberar los números
        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            const numerosAnulados = ventas[ventaIndex].numbers; // Renombrado a 'numbers'
            if (numerosAnulados && numerosAnulados.length > 0) {
                // Leer el estado más reciente de los números desde el archivo para asegurar consistencia
                let currentNumeros = await readJsonFile(NUMEROS_FILE);

                numerosAnulados.forEach(numAnulado => {
                    const numObj = currentNumeros.find(n => n.numero === numAnulado);
                    if (numObj) {
                        numObj.comprado = false; // Marcar como disponible
                    }
                });
                await writeJsonFile(NUMEROS_FILE, currentNumeros);
                // También actualizar la variable global 'numeros' en memoria
                numeros = currentNumeros;
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} han sido puestos nuevamente disponibles.`);
            }
        }
        // NOTA: Si el estado cambia de 'Falso' a 'Confirmado', los números NO se vuelven a marcar como comprados automáticamente aquí.
        // Se asume que una vez anulados, si se confirman de nuevo, se debe gestionar manualmente o con otra lógica.

        await writeJsonFile(VENTAS_FILE, ventas);

        res.status(200).json({ message: `Estado de la venta ${ventaId} actualizado a "${validationStatus}" con éxito.`, venta: ventas[ventaIndex] });
    } catch (error) {
        console.error(`Error al actualizar el estado de la venta ${ventaId}:`, error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el estado de la venta.', error: error.message });
    }
});


// NUEVA RUTA: Endpoint para exportar toda la base de datos en un archivo ZIP
app.get('/api/export-database', async (req, res) => {
    const archive = archiver('zip', {
        zlib: { level: 9 } // Nivel de compresión
    });

    const archiveName = `rifas_db_backup_${moment().format('YYYYMMDD_HHmmss')}.zip`;

    res.attachment(archiveName); // Establece el nombre del archivo de descarga
    archive.pipe(res); // Envía el archivo ZIP como respuesta al cliente

    try {
        for (const filePath of DATABASE_FILES) {
            const fileName = path.basename(filePath);
            try {
                // Asegurarse de que el archivo existe antes de intentar adjuntarlo
                await fs.access(filePath);
                archive.file(filePath, { name: fileName });
            } catch (fileError) {
                if (fileError.code === 'ENOENT') {
                    console.warn(`Archivo no encontrado, omitiendo: ${fileName}`);
                    // Opcional: Crear un archivo vacío o un placeholder si el archivo no existe
                    // archive.append(Buffer.from(''), { name: fileName });
                } else {
                    throw fileError; // Relanza otros errores de archivo
                }
            }
        }
        archive.finalize(); // Finaliza el archivo ZIP
        console.log('Base de datos exportada y enviada como ZIP.');
    } catch (error) {
        console.error('Error al exportar la base de datos:', error);
        res.status(500).send('Error al exportar la base de datos.');
    }
});

// NUEVA RUTA: Endpoint para generar el enlace de WhatsApp para un cliente (pago confirmado)
app.post('/api/generate-whatsapp-customer-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp.' });
    }

    try {
        // Buscar la venta por su ID
        const venta = ventas.find(v => v.id === ventaId);

        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp.' });
        }

        // Construir el mensaje de confirmación para el cliente
        const customerPhoneNumber = venta.buyerPhone; // Renombrado
        const ticketNumber = venta.ticketNumber; // Renombrado
        const purchasedNumbers = venta.numbers.join(', '); // Renombrado
        const valorUsd = venta.valueUSD.toFixed(2); // Renombrado
        const valorBs = venta.valueBs.toFixed(2); // Renombrado
        const metodoPago = venta.paymentMethod; // Renombrado
        const referenciaPago = venta.paymentReference; // Renombrado
        const fechaCompra = moment(venta.purchaseDate).tz("America/Caracas").format('DD/MM/YYYY HH:mm'); // Renombrado

        const whatsappMessage = encodeURIComponent(
            `¡Hola! 👋 Su compra ha sido *confirmada* con éxito. 🎉\n\n` +
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

// NUEVA RUTA: Endpoint para generar el enlace de WhatsApp para notificar pago falso
app.post('/api/generate-whatsapp-false-payment-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp para pago falso.' });
    }

    try {
        // Buscar la venta por su ID
        const venta = ventas.find(v => v.id === ventaId);

        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp de pago falso.' });
        }

        const customerPhoneNumber = venta.buyerPhone; // Renombrado
        const ticketNumber = venta.ticketNumber; // Renombrado
        const comprador = venta.buyerName || 'Estimado cliente'; // Renombrado

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

// NUEVA RUTA: POST /api/tickets/procesar-ganadores
// Este endpoint procesa los tickets vendidos para una fecha/sorteo/lotería dados
// y almacena los tickets ganadores en ganadores.json.
app.post('/api/tickets/procesar-ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.body;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos para procesar ganadores.' });
    }

    try {
        // Cargar los datos más recientes
        const allVentas = await readJsonFile(VENTAS_FILE);
        const allResultadosSorteo = await readJsonFile(RESULTADOS_SORTEO_FILE);
        const allPremios = await readJsonFile(PREMIOS_FILE);

        const ticketsGanadoresParaEsteSorteo = [];

        // 1. Encontrar los resultados del sorteo para la fecha y tipoLoteria
        const resultadosDelDia = allResultadosSorteo.find(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (!resultadosDelDia || !resultadosDelDia.resultados || resultadosDelDia.resultados.length === 0) {
            return res.status(200).json({ message: 'No se encontraron resultados de sorteo para esta fecha y lotería para procesar ganadores.' });
        }

        // 2. Obtener los valores de los premios para la fecha
        const premiosDelDia = allPremios[fecha]; // Acceder directamente por fecha formateada
        if (!premiosDelDia) {
            return res.status(200).json({ message: 'No se encontraron configuraciones de premios para esta fecha para procesar ganadores.' });
        }

        // 3. Iterar sobre los tickets vendidos y determinar ganadores
        allVentas.forEach(venta => {
            // Asegurarse de que la venta sea para la fecha y el número de sorteo correctos
            if (venta.drawDate === fecha && venta.drawNumber.toString() === numeroSorteo.toString()) {
                let coincidentNumbers = [];
                let totalPotentialPrizeUSD = 0;
                let totalPotentialPrizeBs = 0;

                // Para cada resultado por hora en el día del sorteo:
                resultadosDelDia.resultados.forEach(r => {
                    const winningTripleA = r.tripleA ? r.tripleA.toString().padStart(3, '0') : null;
                    const winningTripleB = r.tripleB ? r.tripleB.toString().padStart(3, '0') : null;

                    // Verificar si alguno de los números del ticket coincide con Triple A o Triple B
                    let currentCoincidentNumbersForHour = [];

                    if (winningTripleA && venta.numbers.includes(winningTripleA)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleA, 10));
                    }
                    if (winningTripleB && venta.numbers.includes(winningTripleB)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleB, 10));
                    }

                    if (currentCoincidentNumbersForHour.length > 0) {
                        let prizeConfigForHour;
                        // Mapear la hora del resultado a la clave de premios
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
                        // Acumular todos los números coincidentes de las diferentes horas
                        coincidentNumbers = Array.from(new Set([...coincidentNumbers, ...currentCoincidentNumbersForHour]));
                    }
                });

                if (coincidentNumbers.length > 0) {
                    totalPotentialPrizeBs = totalPotentialPrizeUSD * configuracion.tasa_dolar; // Usar la tasa del dólar actual
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

        // Almacenar los ganadores procesados en ganadoresSorteos
        const now = moment().tz("America/Caracas").toISOString();
        const newWinnersEntry = {
            drawDate: fecha,
            drawNumber: parseInt(numeroSorteo),
            lotteryType: tipoLoteria,
            winners: ticketsGanadoresParaEsteSorteo,
            processedAt: now
        };

        // Buscar si ya existe una entrada para este sorteo y actualizarla, o añadirla
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


// NUEVA RUTA: GET /api/tickets/ganadores
// Este endpoint ahora lee los tickets ganadores de ganadores.json
app.get('/api/tickets/ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.query;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos.' });
    }

    try {
        // Cargar los ganadores procesados (ya están en memoria si loadInitialData se ejecutó)
        // Opcionalmente, puedes volver a leer el archivo aquí para asegurar los datos más recientes
        // const currentGanadoresSorteos = await readJsonFile(GANADORES_FILE);

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
        configureMailer(); // Configurar el mailer después de cargar la configuración inicial
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            // console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app/`); // Esto es solo un ejemplo si lo usas en Netlify
            // console.log(`Frontend principal disponible en: https://tuoportunidadeshoy.netlify.app/`); // Esto es solo un ejemplo si lo usas en Netlify
        });
    });
});
