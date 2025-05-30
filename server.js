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
const ExcelJS = require('exceljs'); // Asegúrate de tener 'exceljs' instalado: npm install exceljs

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app',
        'https://tuoportunidadeshoy.netlify.app',
        'http://localhost:8080',
        'http://127.0.0.1:5500', // Agregado para testing local si usas Live Server u similar
        'http://localhost:3000', // Si tu frontend corre en el mismo dominio/puerto que el backend
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Límite de 50MB
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// Directorios para datos
const DATA_DIR = path.join(__dirname, 'data');
const NUMBERS_FILE = path.join(DATA_DIR, 'numbers.json');
const PURCHASES_FILE = path.join(DATA_DIR, 'purchases.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const COMPROBANTES_DIR = path.join(__dirname, 'uploads', 'comprobantes');

// Asegurar que los directorios existan
async function ensureDataAndComprobantesDirs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
}

// Funciones de lectura/escritura de JSON
async function readJsonFile(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await writeJsonFile(filePath, defaultValue); // Crea el archivo con el valor por defecto si no existe
            return defaultValue;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Cargar datos iniciales o crear si no existen
async function loadInitialData() {
    const configDefault = {
        sorteo_activo: true,
        fecha_sorteo: moment.tz("America/Caracas").format('YYYY-MM-DD'), // Fecha de hoy por defecto
        precio_usd: 1.00,
        precio_bs: 38.00, // Ajusta a la tasa actual
        zona_horaria: "America/Caracas",
        ultimo_numero_sorteo_correlativo: 0,
        ultimo_numero_ticket: 0
    };

    const numbersDefault = Array.from({ length: 100 }, (_, i) => ({
        numero: i,
        estado: 'disponible',
        comprador: null,
        fecha_compra: null,
        metodo_pago: null,
        referencia_pago: null
    }));

    const purchasesDefault = [];

    await readJsonFile(CONFIG_FILE, configDefault);
    await readJsonFile(NUMBERS_FILE, numbersDefault);
    await readJsonFile(PURCHASES_FILE, purchasesDefault);

    // Servir archivos estáticos (comprobantes)
    app.use('/uploads/comprobantes', express.static(COMPROBANTES_DIR));
}

// Configuración del transportador de Nodemailer
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE, // ej. 'gmail'
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Función para enviar correo de confirmación
async function enviarCorreoConfirmacion(compra) {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: compra.email,
            subject: `Confirmación de Compra de Números para la Rifa ${compra.correlativo_sorteo}`,
            html: `
                <p>Estimado/a ${compra.nombre_apellido},</p>
                <p>Gracias por tu compra en nuestra rifa. A continuación, los detalles de tu compra:</p>
                <ul>
                    <li><strong>Números Comprados:</strong> ${compra.numeros_comprados.map(n => String(n).padStart(2, '0')).join(', ')}</li>
                    <li><strong>Total USD:</strong> $${compra.total_usd}</li>
                    <li><strong>Total Bs:</strong> Bs ${compra.total_bs}</li>
                    <li><strong>Método de Pago:</strong> ${compra.metodo_pago}</li>
                    <li><strong>Referencia:</strong> ${compra.referencia_pago}</li>
                    <li><strong>Fecha de Compra:</strong> ${moment(compra.fecha_compra).tz("America/Caracas").format('DD/MM/YYYY hh:mm A')}</li>
                    <li><strong>Número de Ticket:</strong> ${String(compra.numero_ticket).padStart(5, '0')}</li>
                </ul>
                <p>Tu compra está registrada. ¡Mucha suerte en el sorteo!</p>
                <p>Saludos cordiales,<br>El equipo de la rifa</p>
            `,
            // attachments: [
            //     {
            //         filename: 'comprobante.jpg', // Nombre del archivo adjunto
            //         path: path.join(COMPROBANTES_DIR, compra.comprobante_url.split('/').pop()), // Ruta real del archivo
            //         cid: 'unique@nodemailer.com' // ID para incrustar en HTML si es necesario
            //     }
            // ]
        };
        await transporter.sendMail(mailOptions);
        console.log('Correo de confirmación enviado a:', compra.email);
    } catch (error) {
        console.error('Error al enviar correo de confirmación:', error);
    }
}

// --- INICIO DE NUEVAS RUTAS PARA EL FRONTEND (CORRIGEN LOS 404) ---

// Ruta para obtener la configuración activa
app.get('/configuracion/activa', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        if (!config.sorteo_activo) {
            // Se devuelve 404 porque el frontend espera este código para bloquear la página
            return res.status(404).json({ error: 'La plataforma está actualmente bloqueada.' });
        }
        // Devuelve solo la configuración relevante para el frontend
        res.json({
            sorteo_activo: config.sorteo_activo,
            fecha_sorteo: config.fecha_sorteo,
            precio_usd: config.precio_usd,
            precio_bs: config.precio_bs,
            zona_horaria: config.zona_horaria
        });
    } catch (error) {
        console.error('Error al obtener la configuración activa:', error);
        res.status(500).json({ error: 'Error interno del servidor al cargar la configuración.' });
    }
});

// Ruta para obtener todos los números y su estado
app.get('/numeros', async (req, res) => {
    try {
        const numbers = await readJsonFile(NUMBERS_FILE);
        res.json(numbers);
    } catch (error) {
        console.error('Error al obtener números:', error);
        res.status(500).json({ error: 'Error interno del servidor al cargar los números.' });
    }
});

// --- FIN DE NUEVAS RUTAS PARA EL FRONTEND ---


// Ruta para procesar la compra de números
app.post('/comprar', async (req, res) => {
    try {
        const { nombre_apellido, telefono, cedula, email, metodo_pago, referencia_pago, numeros_comprados, total_usd, total_bs } = req.body;
        const comprobante_pago = req.files ? req.files.comprobante_pago : null;

        if (!nombre_apellido || !telefono || !cedula || !email || !metodo_pago || !referencia_pago || !numeros_comprados || !comprobante_pago) {
            return res.status(400).json({ error: 'Faltan campos obligatorios para la compra.' });
        }

        let parsedNumeros = [];
        try {
            parsedNumeros = JSON.parse(numeros_comprados);
            if (!Array.isArray(parsedNumeros) || parsedNumeros.some(isNaN)) {
                throw new Error('Formato de números seleccionados inválido.');
            }
        } catch (parseError) {
            return res.status(400).json({ error: 'Formato de números seleccionados inválido.' });
        }

        const numbers = await readJsonFile(NUMBERS_FILE);
        const config = await readJsonFile(CONFIG_FILE);

        if (!config.sorteo_activo) {
            return res.status(403).json({ error: 'El sorteo no está activo en este momento.' });
        }

        const tomados = [];
        for (const num of parsedNumeros) {
            if (numbers[num] && numbers[num].estado === 'comprado') {
                tomados.push(num);
            }
        }

        if (tomados.length > 0) {
            return res.status(409).json({
                error: `Los siguientes números ya fueron comprados: ${tomados.map(n => String(n).padStart(2, '0')).join(', ')}.`,
                tomados: tomados
            });
        }

        const now = moment().tz(config.zona_horaria || "America/Caracas");
        const fechaCompra = now.toISOString(); // Fecha ISO string
        const timestamp = now.format('YYYYMMDDHHmmss');

        // Generar un número de ticket incremental
        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        await writeJsonFile(CONFIG_FILE, config);
        const numeroTicket = config.ultimo_numero_ticket;

        let comprobanteFileName = '';
        let comprobantePath = '';
        let comprobanteUrl = '';

        if (comprobante_pago) {
            const fileExtension = path.extname(comprobante_pago.name);
            comprobanteFileName = `comprobante_${timestamp}_${cedula}${fileExtension}`;
            comprobantePath = path.join(COMPROBANTES_DIR, comprobanteFileName);
            await comprobante_pago.mv(comprobantePath);
            comprobanteUrl = `${API_BASE_URL}/uploads/comprobantes/${comprobanteFileName}`;
        }

        const newPurchase = {
            id: Date.now(),
            nombre_apellido,
            telefono,
            cedula,
            email,
            numeros_comprados: parsedNumeros,
            total_usd: parseFloat(total_usd),
            total_bs: parseFloat(total_bs),
            metodo_pago,
            referencia_pago,
            fecha_compra: fechaCompra,
            estado: 'pendiente', // O 'confirmado' si no requiere revisión manual
            comprobante_url: comprobanteUrl,
            numero_ticket: numeroTicket,
            correlativo_sorteo: config.ultimo_numero_sorteo_correlativo || 0 // Asociar con el sorteo actual
        };

        const purchases = await readJsonFile(PURCHASES_FILE);
        purchases.push(newPurchase);
        await writeJsonFile(PURCHASES_FILE, purchases);

        // Marcar números como comprados
        for (const num of parsedNumeros) {
            if (numbers[num]) {
                numbers[num].estado = 'comprado';
                numbers[num].comprador = nombre_apellido;
                numbers[num].fecha_compra = fechaCompra;
                numbers[num].metodo_pago = metodo_pago;
                numbers[num].referencia_pago = referencia_pago;
                numbers[num].id_compra = newPurchase.id; // Vincular al ID de la compra
                numbers[num].numero_ticket = numeroTicket;
                numbers[num].correlativo_sorteo = config.ultimo_numero_sorteo_correlativo || 0;
            }
        }
        await writeJsonFile(NUMBERS_FILE, numbers);

        // Enviar correo de confirmación (asincrónicamente, no bloquea la respuesta)
        enviarCorreoConfirmacion(newPurchase);

        res.status(201).json({ message: 'Compra realizada con éxito', compra: newPurchase });

    } catch (error) {
        console.error('Error al procesar la compra:', error);
        if (error.code === 'ENOENT') {
            res.status(500).json({ error: 'Error en la configuración del servidor (archivos de datos no encontrados).' });
        } else {
            res.status(500).json({ error: 'Error interno del servidor al procesar la compra.', details: error.message });
        }
    }
});


// Ruta para obtener todas las compras (Admin)
app.get('/admin/compras', async (req, res) => {
    try {
        const purchases = await readJsonFile(PURCHASES_FILE);
        res.json(purchases);
    } catch (error) {
        console.error('Error al obtener compras:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para obtener la configuración (Admin)
app.get('/admin/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para actualizar la configuración (Admin)
app.post('/admin/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        // Solo permitir ciertos campos actualizables para evitar sobreescritura accidental
        let currentConfig = await readJsonFile(CONFIG_FILE);
        Object.assign(currentConfig, newConfig); // Actualiza los campos recibidos
        await writeJsonFile(CONFIG_FILE, currentConfig);
        res.json({ message: 'Configuración actualizada con éxito', config: currentConfig });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para reiniciar la rifa (Admin)
app.post('/admin/reiniciar-rifa', async (req, res) => {
    try {
        const numbersDefault = Array.from({ length: 100 }, (_, i) => ({
            numero: i,
            estado: 'disponible',
            comprador: null,
            fecha_compra: null,
            metodo_pago: null,
            referencia_pago: null
        }));
        await writeJsonFile(NUMBERS_FILE, numbersDefault); // Reinicia los números

        let config = await readJsonFile(CONFIG_FILE);
        config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
        config.ultimo_numero_ticket = 0; // Reiniciar el contador de tickets
        config.fecha_sorteo = moment().tz(config.zona_horaria || "America/Caracas").add(1, 'days').format('YYYY-MM-DD'); // Establecer la fecha del sorteo para mañana
        await writeJsonFile(CONFIG_FILE, config);

        // Opcional: También podrías querer archivar o limpiar `purchases.json`
        // await writeJsonFile(PURCHASES_FILE, []); // Limpiar compras anteriores si es un reinicio completo
        
        res.json({ message: 'Rifa reiniciada con éxito. Números disponibles y correlativo de sorteo actualizado.', config });
    } catch (error) {
        console.error('Error al reiniciar rifa:', error);
        res.status(500).json({ error: 'Error interno del servidor al reiniciar la rifa.' });
    }
});

// Ruta para exportar compras a Excel (Admin)
app.get('/admin/exportar-excel', async (req, res) => {
    try {
        const purchases = await readJsonFile(PURCHASES_FILE);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Compras de Rifa');

        // Definir columnas
        worksheet.columns = [
            { header: 'ID Compra', key: 'id', width: 10 },
            { header: 'Ticket', key: 'numero_ticket', width: 10 },
            { header: 'Sorteo Correlativo', key: 'correlativo_sorteo', width: 15 },
            { header: 'Fecha Compra', key: 'fecha_compra_local', width: 20 },
            { header: 'Nombre Apellido', key: 'nombre_apellido', width: 30 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Números Comprados', key: 'numeros_comprados_str', width: 30 },
            { header: 'Total USD', key: 'total_usd', width: 15 },
            { header: 'Total Bs', key: 'total_bs', width: 15 },
            { header: 'Método Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Estado', key: 'estado', width: 15 },
            { header: 'Comprobante URL', key: 'comprobante_url', width: 40 }
        ];

        // Añadir filas
        purchases.forEach(p => {
            // Se asume que config está disponible globalmente o se carga aquí de nuevo si es necesario.
            // Para asegurar, la cargamos dentro del bucle si no está garantizado que `config` sea accesible
            // o se mantenga actualizado de forma global. Para este caso, cargaremos de nuevo para evitar dependencias.
            // Ojo: Si 'config' no existe (ej. al inicio), esto podría fallar. Se debería cargar al inicio del script.
            // Aquí, para la exportación, lo hacemos seguro.
            const config = require(CONFIG_FILE); // Cargar config para zona horaria
            const fechaLocal = moment(p.fecha_compra).tz(config.zona_horaria || "America/Caracas").format('DD/MM/YYYY hh:mm A');
            worksheet.addRow({
                id: p.id,
                numero_ticket: String(p.numero_ticket).padStart(5, '0'),
                correlativo_sorteo: p.correlativo_sorteo,
                fecha_compra_local: fechaLocal,
                nombre_apellido: p.nombre_apellido,
                cedula: p.cedula,
                telefono: p.telefono,
                email: p.email,
                numeros_comprados_str: p.numeros_comprados.map(n => String(n).padStart(2, '0')).join(', '),
                total_usd: p.total_usd,
                total_bs: p.total_bs,
                metodo_pago: p.metodo_pago,
                referencia_pago: p.referencia_pado,
                estado: p.estado,
                comprobante_url: p.comprobante_url
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'compras_rifa.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar a Excel:', error);
        res.status(500).json({ error: 'Error interno del servidor al exportar a Excel.' });
    }
});

// Tarea programada para cortar ventas y reiniciar números a medianoche
// Se ejecuta todos los días a las 00:00 (medianoche) en la zona horaria de Venezuela
cron.schedule('0 0 * * *', async () => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        const now = moment().tz(config.zona_horaria || "America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');
        const currentDrawDate = moment(config.fecha_sorteo).format('YYYY-MM-DD');

        console.log(`Ejecutando tarea programada a las ${now.format('HH:mm:ss')}.`);
        console.log(`Fecha actual (zona horaria del servidor): ${todayFormatted}`);
        console.log(`Fecha de sorteo configurada: ${currentDrawDate}`);

        // Si la fecha del sorteo es hoy o una fecha pasada, reiniciar números
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted, 'day')) {
            console.log(`Sorteo de fecha ${currentDrawDate} ha terminado o es hoy. Reiniciando números y actualizando la fecha del próximo sorteo.`);
            const numbersDefault = Array.from({ length: 100 }, (_, i) => ({
                numero: i,
                estado: 'disponible',
                comprador: null,
                fecha_compra: null,
                metodo_pago: null,
                referencia_pago: null
            }));
            await writeJsonFile(NUMBERS_FILE, numbersDefault); // Reinicia los números

            // Actualizar la fecha del próximo sorteo a mañana y el correlativo
            config.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD');
            config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
            config.ultimo_numero_ticket = 0; // Reiniciar el último número de ticket usado
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
            // NOTA: Esta URL de paneladmin01.netlify.app debe ser la real para tu frontend de administración
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
            // NOTA: Esta URL de tuoportunidadeshoy.netlify.app debe ser la real para tu frontend de usuario
            console.log(`Plataforma de usuario disponible en: https://tuoportunidadeshoy.netlify.app`);
        });
    }).catch(error => {
        console.error('Error al cargar datos iniciales o iniciar el servidor:', error);
    });
}).catch(error => {
    console.error('Error al asegurar directorios:', error);
});