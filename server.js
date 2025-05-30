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
// **QUITAR O COMENTAR fileUpload si ya no se usarán archivos**
// Si NO hay NINGÚN otro endpoint que use fileUpload, puedes eliminarlo completamente.
// Si hay otros endpoints que SÍ usan archivos (Ej: para el admin), entonces déjalo, pero quita el uso en /comprar.
// Para este caso, lo dejaré comentado. Si tienes otras rutas que suben archivos, descoméntalo.
// app.use(fileUpload({
//     limits: { fileSize: 50 * 1024 * 1024 }, // Límite de 50MB
//     useTempFiles: true,
//     tempFileDir: '/tmp/'
// }));

// Directorios para guardar datos y comprobantes
const DATA_DIR = path.join(__dirname, 'data');
// **QUITAR O COMENTAR COMPROBANTES_DIR si ya no se usarán archivos**
// const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');
const COMPRAS_FILE = path.join(DATA_DIR, 'compras.json');

// --- Funciones de utilidad para manejo de archivos (Mantener si usas JSON files) ---
async function readJsonFile(filePath, defaultValue = []) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Creando con valor por defecto.`);
            await writeJsonFile(filePath, defaultValue);
            return defaultValue;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function ensureDataAndComprobantesDirs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    // **QUITAR O COMENTAR mkdir para COMPROBANTES_DIR**
    // await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
}

// --- Carga inicial de datos (Mantener si usas JSON files) ---
let config = {};
let numeros = [];
let compras = [];

async function loadInitialData() {
    try {
        config = await readJsonFile(CONFIG_FILE, {
            precio_bs: 0.5,
            precio_usd: 0.01,
            fecha_sorteo: moment().tz("America/Caracas").add(7, 'days').format('YYYY-MM-DD HH:mm:ss'),
            zona_horaria: "America/Caracas",
            activa: true,
            ultimo_numero_ticket: 0,
            ultimo_numero_sorteo_correlativo: 0,
            telefono_soporte_whatsapp: '584140000000' // Número de ejemplo
        });
        numeros = await readJsonFile(NUMEROS_FILE, Array.from({ length: 100 }, (_, i) => ({ numero: i, estado: 'disponible' })));
        compras = await readJsonFile(COMPRAS_FILE);
        console.log("Datos cargados exitosamente.");
    } catch (error) {
        console.error("Error al cargar los datos iniciales:", error);
        process.exit(1); // Salir si no se pueden cargar los datos cruciales
    }
}

// --- Rutas de la API ---

// Ruta para obtener configuración activa
app.get('/configuracion/activa', (req, res) => {
    if (config.activa) {
        res.json(config);
    } else {
        res.status(404).json({ message: 'No hay configuración activa disponible.' });
    }
});

// Ruta para obtener todos los números
app.get('/numeros', (req, res) => {
    res.json(numeros);
});

// Ruta para obtener compras (solo para admin, considera autenticación)
app.get('/compras', (req, res) => {
    res.json(compras);
});

// Ruta para generar reporte Excel (solo para admin)
app.get('/generar-reporte', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Compras');

        worksheet.columns = [
            { header: 'ID Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'nombre_apellido', width: 30 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números', key: 'numeros_comprados', width: 25 },
            { header: 'Total USD', key: 'total_usd', width: 10 },
            { header: 'Total Bs', key: 'total_bs', width: 15 },
            { header: 'Método Pago', key: 'metodo_pago', width: 15 },
            { header: 'Referencia', key: 'referencia_pago', width: 20 },
            { header: 'Fecha Compra', key: 'fecha_compra', width: 20 },
            { header: 'Estado', key: 'estado', width: 10 },
            // { header: 'URL Comprobante', key: 'url_comprobante', width: 40 } // ELIMINAR O COMENTAR
        ];

        compras.forEach(compra => {
            worksheet.addRow({
                ...compra,
                numeros_comprados: compra.numeros_comprados.join(', '),
                fecha_compra: moment(compra.fecha_compra).tz(config.zona_horaria).format('DD/MM/YYYY HH:mm:ss')
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'reporte_compras.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al generar reporte Excel:', error);
        res.status(500).json({ error: 'Error al generar el reporte.' });
    }
});


// Ruta principal de compra
app.post('/comprar', async (req, res) => {
    try {
        const { nombre_apellido, telefono, cedula, email, metodo_pago, referencia_pago, numeros_comprados, total_usd, total_bs } = req.body;
        // **ELIMINAR LA LÍNEA DEL COMPROBANTE DE PAGO**
        // const comprobante_pago = req.files ? req.files.comprobante_pago : null;

        // **Validación de campos obligatorios (SIN COMPROBANTE)**
        if (!nombre_apellido || !telefono || !cedula || !email || !metodo_pago || !referencia_pago || !numeros_comprados) {
            return res.status(400).json({ error: 'Faltan campos obligatorios para la compra (nombre, teléfono, cédula, email, método de pago, referencia, números seleccionados).' });
        }

        // Validación y parseo de numeros_comprados
        let parsedNumeros = [];
        try {
            parsedNumeros = JSON.parse(numeros_comprados);
            if (!Array.isArray(parsedNumeros) || parsedNumeros.length === 0 || parsedNumeros.some(n => typeof n !== 'number' || n < 0 || n > 99)) {
                throw new Error('Formato de números seleccionados inválido. Debe ser un array de números de 0 a 99.');
            }
        } catch (parseError) {
            console.error('Error al parsear numeros_comprados:', parseError);
            return res.status(400).json({ error: 'Formato de números seleccionados inválido.' });
        }

        // Validar que los números seleccionados estén disponibles
        const tomados = [];
        for (const num of parsedNumeros) {
            const numeroEncontrado = numeros.find(n => n.numero === num);
            if (!numeroEncontrado || numeroEncontrado.estado === 'comprado') {
                tomados.push(num);
            }
        }

        if (tomados.length > 0) {
            return res.status(409).json({
                error: 'Algunos de los números seleccionados ya fueron comprados. Por favor, selecciona otros.',
                tomados: tomados
            });
        }

        // **ELIMINAR LÓGICA DE MOVER Y GUARDAR COMPROBANTE**
        // const fileName = `${Date.now()}_${comprobante_pago.name}`;
        // const filePath = path.join(COMPROBANTES_DIR, fileName);
        // await comprobante_pago.mv(filePath);
        // const comprobanteUrl = `${API_BASE_URL}/comprobantes/${fileName}`; // URL accesible públicamente
        const comprobanteUrl = null; // Asignar null ya que no hay comprobante

        // Generar número de ticket correlativo
        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        const numeroTicket = String(config.ultimo_numero_ticket).padStart(5, '0'); // Formato de 5 dígitos (00001)

        const fechaCompra = moment().tz(config.zona_horaria).format('YYYY-MM-DD HH:mm:ss');

        const newPurchase = {
            id: Date.now(), // ID único para el registro (timestamp)
            numero_ticket: numeroTicket, // Número de ticket correlativo asignado por el backend
            nombre_apellido,
            telefono,
            cedula, // Cédula es obligatoria
            email,   // Email es obligatorio
            numeros_comprados: parsedNumeros,
            total_usd: parseFloat(total_usd),
            total_bs: parseFloat(total_bs),
            metodo_pago,
            referencia_pago,
            fecha_compra: fechaCompra,
            estado: 'pendiente', // O 'confirmado' si no requiere revisión
            url_comprobante: comprobanteUrl, // Será null
            correlativo_sorteo: config.ultimo_numero_sorteo_correlativo || 0 // Asociar al correlativo del sorteo actual
        };

        // Actualizar el estado de los números en el array 'numeros'
        parsedNumeros.forEach(num => {
            const index = numeros.findIndex(n => n.numero === num);
            if (index !== -1) {
                numeros[index].estado = 'comprado';
                numeros[index].comprador_id = newPurchase.id; // Asocia la compra al número
                numeros[index].numero_ticket = newPurchase.numero_ticket; // Asocia el ticket al número
            }
        });

        // Guardar la nueva compra y los números actualizados
        compras.push(newPurchase);
        await writeJsonFile(COMPRAS_FILE, compras);
        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(CONFIG_FILE, config); // Guardar el config con el nuevo último ticket

        res.status(201).json({ message: 'Compra realizada con éxito. Esperando validación del pago.', compra: newPurchase });

        // --- Lógica de envío de correo (si está configurada) ---
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.ADMIN_EMAIL) {
            const transporter = nodemailer.createTransport({
                service: 'Gmail', // O el servicio de correo que uses
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS,
                },
            });

            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.ADMIN_EMAIL,
                subject: `Nueva Compra - Ticket #${numeroTicket}`,
                html: `
                    <p>Se ha realizado una nueva compra en la plataforma:</p>
                    <ul>
                        <li><strong>Ticket:</strong> ${numeroTicket}</li>
                        <li><strong>Comprador:</strong> ${nombre_apellido}</li>
                        <li><strong>Teléfono:</strong> ${telefono}</li>
                        <li><strong>Cédula:</strong> ${cedula || 'N/A'}</li>
                        <li><strong>Email:</strong> ${email || 'N/A'}</li>
                        <li><strong>Números:</strong> ${parsedNumeros.join(', ')}</li>
                        <li><strong>Total USD:</strong> $${parseFloat(total_usd).toFixed(2)}</li>
                        <li><strong>Total Bs:</strong> Bs ${parseFloat(total_bs).toFixed(2)}</li>
                        <li><strong>Método de Pago:</strong> ${metodo_pago}</li>
                        <li><strong>Referencia:</strong> ${referencia_pago}</li>
                        <li><strong>Fecha:</strong> ${fechaCompra}</li>
                    </ul>
                    <p>Comprobante de Pago: Ya no se adjunta.</p>
                `,
            };

            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    console.error('Error al enviar el correo:', error);
                } else {
                    console.log('Correo enviado: ' + info.response);
                }
            });
        }

    } catch (error) {
        console.error('Error en la ruta /comprar:', error);
        res.status(500).json({ error: 'Error interno del servidor al procesar la compra.', details: error.message });
    }
});

// **ELIMINAR RUTA PARA SERVIR COMPROBANTES**
// app.use('/comprobantes', express.static(COMPROBANTES_DIR));


// --- Tarea programada para reinicio diario/semanal (solo si usas JSON files) ---
cron.schedule('0 0 * * *', async () => { // Se ejecuta todos los días a medianoche (00:00)
    console.log('Ejecutando tarea programada de corte de ventas y reinicio...');
    try {
        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');
        const currentDrawDate = moment(config.fecha_sorteo).tz("America/Caracas").format('YYYY-MM-DD');

        // Si la fecha del sorteo actual es anterior o igual a hoy, es hora de reiniciar
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted, 'day')) {
            console.log("Reiniciando números y actualizando fecha de sorteo...");
            // Reiniciar todos los números a 'disponible'
            numeros.forEach(n => {
                n.estado = 'disponible';
                delete n.comprador_id;
                delete n.numero_ticket;
            });
            await writeJsonFile(NUMEROS_FILE, numeros);

            // Actualizar la fecha del sorteo a una semana en el futuro
            config.fecha_sorteo = moment().tz("America/Caracas").add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
            config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
            config.ultimo_numero_ticket = 0; // Reiniciar el contador de ticket para el nuevo sorteo
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.ultimo_numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas"
});


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
            console.log(`Plataforma de usuario disponible en: https://tuoportunidadeshoy.netlify.app`);
        });
    }).catch(error => {
        console.error("Error fatal al iniciar el servidor:", error);
        process.exit(1);
    });
}).catch(error => {
    console.error("Error al asegurar directorios:", error);
    process.exit(1);
});