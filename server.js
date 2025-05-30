// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises; // Usar la versión de promesas de fs
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone');
const ExcelJS = require('exceljs');

dotenv.config(); // Cargar variables de entorno desde .env

const app = express();
const port = process.env.PORT || 3000;

const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// --- Configuración de CORS ---
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app',
        'https://tuoportunidadeshoy.netlify.app',
        'http://localhost:8080',
        'http://127.0.0.1:5500', // Para Live Server de VS Code
        'http://localhost:3000', // Si tu frontend está en localhost:3000
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json()); // Para parsear JSON en el cuerpo de las solicitudes
app.use(express.urlencoded({ extended: true })); // Para parsear URL-encoded data
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Limite de 50MB para archivos
    debug: true // Habilitar depuración para fileUpload
}));

// --- Rutas a los archivos JSON de datos ---
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SALES_FILE = path.join(DATA_DIR, 'ventas.json');
const COMPRAS_FILE = path.join(DATA_DIR, 'compras.json'); // Usado para el registro detallado de cada compra (tickets)
const NUMBERS_FILE = path.join(DATA_DIR, 'numeros.json'); // Archivo para los números disponibles/vendidos
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horarios-zulia.json'); // Nuevo archivo para horarios de Zulia

const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes'); // Directorio para guardar comprobantes de pago

// --- Funciones auxiliares para leer/escribir JSON ---
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Creando con valor por defecto.`);
            // Devolver un valor por defecto basado en el archivo
            if (filePath === CONFIG_FILE) {
                return {
                    precio_ticket_bs: 0,
                    precio_ticket_usd: 0,
                    tasa_dolar: 0,
                    fecha_sorteo: moment().tz("America/Caracas").format('YYYY-MM-DD'),
                    ultimo_numero_sorteo_correlativo: 0,
                    ultimo_numero_ticket: 0,
                    pagina_bloqueada: false // Por defecto la página no está bloqueada
                };
            } else if (filePath === SALES_FILE || filePath === COMPRAS_FILE || filePath === NUMBERS_FILE || filePath === HORARIOS_ZULIA_FILE) {
                return []; // Por defecto, un array vacío para ventas, compras, números y horarios
            }
        }
        throw error; // Re-lanzar otros errores
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Middleware para asegurar que los directorios de datos existan ---
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
        console.log('Directorios de datos y comprobantes asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios:', error);
        process.exit(1); // Salir si no se pueden crear los directorios críticos
    }
}

// --- Carga de datos iniciales al arrancar el servidor ---
async function loadInitialData() {
    try {
        // Asegurar que los archivos JSON existen con un contenido inicial válido
        await writeJsonFile(CONFIG_FILE, await readJsonFile(CONFIG_FILE));
        await writeJsonFile(SALES_FILE, await readJsonFile(SALES_FILE));
        await writeJsonFile(COMPRAS_FILE, await readJsonFile(COMPRAS_FILE));
        await writeJsonFile(NUMBERS_FILE, await readJsonFile(NUMBERS_FILE));
        await writeJsonFile(HORARIOS_ZULIA_FILE, await readJsonFile(HORARIOS_ZULIA_FILE)); // Inicializa horarios

        console.log('Datos cargados exitosamente.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
        process.exit(1); // Salir si hay un error crítico en la carga de datos
    }
}

// --- Configuración de Nodemailer (para envío de correos) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// --- Rutas de la API ---

// 1. Rutas de Configuración General (para el Panel de Administración)
// Nueva ruta para obtener toda la configuración
app.get('/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        console.error('Error al leer configuración completa:', error);
        res.status(500).json({ message: 'Error interno del servidor al cargar la configuración completa.' });
    }
});

// Ruta para obtener la configuración activa (para la plataforma de usuario)
app.get('/configuracion/activa', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        // Devolver solo los datos relevantes para la plataforma de usuario
        if (config) {
            res.json({
                precio_ticket_bs: config.precio_ticket_bs,
                precio_ticket_usd: config.precio_ticket_usd,
                tasa_dolar: config.tasa_dolar,
                fecha_sorteo: config.fecha_sorteo,
                ultimo_numero_sorteo_correlativo: config.ultimo_numero_sorteo_correlativo,
                pagina_bloqueada: config.pagina_bloqueada
            });
        } else {
            res.status(404).json({ message: 'No hay configuración activa disponible.' });
        }
    } catch (error) {
        console.error('Error al leer configuración activa:', error);
        res.status(500).json({ message: 'Error interno del servidor al cargar la configuración activa.' });
    }
});

// Rutas PATCH para actualizar configuraciones específicas
app.patch('/configuracion/precio-bs', async (req, res) => {
    try {
        const { precio_bs } = req.body;
        if (typeof precio_bs !== 'number' || precio_bs < 0) {
            return res.status(400).json({ message: 'Precio BS debe ser un número positivo.' });
        }
        const config = await readJsonFile(CONFIG_FILE);
        config.precio_ticket_bs = precio_bs;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Precio del ticket en BS actualizado con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar precio BS:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.patch('/configuracion/precio-usd', async (req, res) => {
    try {
        const { precio_usd } = req.body;
        if (typeof precio_usd !== 'number' || precio_usd < 0) {
            return res.status(400).json({ message: 'Precio USD debe ser un número positivo.' });
        }
        const config = await readJsonFile(CONFIG_FILE);
        config.precio_ticket_usd = precio_usd;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Precio del ticket en USD actualizado con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar precio USD:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.patch('/configuracion/tasa-dolar', async (req, res) => {
    try {
        const { tasa_dolar } = req.body;
        if (typeof tasa_dolar !== 'number' || tasa_dolar < 0) {
            return res.status(400).json({ message: 'Tasa dólar debe ser un número positivo.' });
        }
        const config = await readJsonFile(CONFIG_FILE);
        config.tasa_dolar = tasa_dolar;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Tasa del dólar actualizada con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar tasa dólar:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.patch('/configuracion/fecha-sorteo', async (req, res) => {
    try {
        const { fecha_sorteo } = req.body;
        if (!moment(fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
            return res.status(400).json({ message: 'Formato de fecha de sorteo inválido. Use YYYY-MM-DD.' });
        }
        const config = await readJsonFile(CONFIG_FILE);
        config.fecha_sorteo = fecha_sorteo;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Fecha de sorteo actualizada con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar fecha sorteo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.patch('/configuracion/correlativo', async (req, res) => {
    try {
        const { correlativo } = req.body;
        if (typeof correlativo !== 'number' || correlativo < 0) {
            return res.status(400).json({ message: 'Correlativo debe ser un número positivo.' });
        }
        const config = await readJsonFile(CONFIG_FILE);
        config.ultimo_numero_sorteo_correlativo = correlativo;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Número de sorteo correlativo actualizado con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar correlativo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.patch('/configuracion/bloqueo', async (req, res) => {
    try {
        const { pagina_bloqueada } = req.body;
        if (typeof pagina_bloqueada !== 'boolean') {
            return res.status(400).json({ message: 'El valor de bloqueo debe ser un booleano (true/false).' });
        }
        const config = await readJsonFile(CONFIG_FILE);
        config.pagina_bloqueada = pagina_bloqueada;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: `Página ${pagina_bloqueada ? 'bloqueada' : 'desbloqueada'} con éxito.`, config });
    } catch (error) {
        console.error('Error al actualizar estado de bloqueo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// 2. Rutas de Horarios Zulia
// Ruta para obtener todos los horarios del Zulia
app.get('/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        console.error('Error al leer horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al cargar horarios del Zulia.' });
    }
});

// Ruta para agregar un nuevo horario del Zulia
app.post('/horarios-zulia', async (req, res) => {
    try {
        const { horario } = req.body; // El cuerpo de la solicitud debe tener { "horario": "HH:MM" }
        if (!horario || typeof horario !== 'string' || !/^\d{2}:\d{2}$/.test(horario)) {
            return res.status(400).json({ message: 'Horario inválido. Formato esperado HH:MM.' });
        }
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        // Asignar un ID único simple
        const newId = horarios.length > 0 ? Math.max(...horarios.map(h => h.id)) + 1 : 1;
        horarios.push({ id: newId, horario });
        await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
        res.status(201).json({ message: 'Horario agregado con éxito', id: newId });
    } catch (error) {
        console.error('Error al agregar horario del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al agregar horario del Zulia.' });
    }
});

// Ruta para eliminar un horario del Zulia por ID
app.delete('/horarios-zulia/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        const initialLength = horarios.length;
        // Filtrar para eliminar el horario con el ID proporcionado
        horarios = horarios.filter(h => h.id !== parseInt(id));
        if (horarios.length === initialLength) {
            return res.status(404).json({ message: 'Horario no encontrado.' });
        }
        await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
        res.json({ message: 'Horario eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar horario del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al eliminar horario del Zulia.' });
    }
});


// 3. Rutas de Números y Compras
// Ruta para obtener todos los números disponibles (y sus estados)
app.get('/numeros', async (req, res) => {
    try {
        const numbers = await readJsonFile(NUMBERS_FILE);
        res.json(numbers);
    } catch (error) {
        console.error('Error al leer números:', error);
        res.status(500).json({ message: 'Error interno del servidor al cargar números.' });
    }
});

// Ruta para registrar una nueva compra de números
app.post('/comprar', async (req, res) => {
    try {
        const {
            numerosSeleccionados,
            nombreApellido,
            telefono,
            cedula,
            email,
            metodoPago,
            referenciaPago,
            valorTotalBs,
            valorTotalUsd
        } = req.body;

        if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !nombreApellido || !telefono || !metodoPago || !referenciaPago || valorTotalBs === undefined || valorTotalUsd === undefined) {
            return res.status(400).json({ message: 'Faltan datos obligatorios para la compra.' });
        }

        let config = await readJsonFile(CONFIG_FILE);
        let numbers = await readJsonFile(NUMBERS_FILE);
        let compras = await readJsonFile(COMPRAS_FILE); // Registro detallado de tickets
        let sales = await readJsonFile(SALES_FILE); // Resumen de ventas

        const currentDrawDate = config.fecha_sorteo;
        const currentCorrelativo = config.ultimo_numero_sorteo_correlativo;

        // Verificar si algún número ya está vendido
        const alreadySold = numerosSeleccionados.some(num => numbers.includes(num));
        if (alreadySold) {
            return res.status(409).json({ message: 'Alguno de los números seleccionados ya ha sido vendido. Por favor, actualiza la página y selecciona otros.' });
        }

        // Marcar números como vendidos
        const newNumbers = [...numbers, ...numerosSeleccionados];
        await writeJsonFile(NUMBERS_FILE, newNumbers);

        // Incrementar el último número de ticket y el correlativo del sorteo si es necesario
        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        await writeJsonFile(CONFIG_FILE, config);

        const newTicketNumber = config.ultimo_numero_ticket;

        // Crear registro de la compra (ticket)
        const newCompra = {
            id: compras.length > 0 ? Math.max(...compras.map(c => c.id)) + 1 : 1, // ID único para cada compra
            fecha_hora_compra: moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
            fecha_sorteo: currentDrawDate,
            numero_sorteo_correlativo: currentCorrelativo,
            numero_ticket: newTicketNumber,
            comprador: nombreApellido,
            telefono: telefono,
            cedula: cedula || 'N/A',
            email: email || 'N/A',
            numeros: numerosSeleccionados,
            valor_usd: valorTotalUsd,
            valor_bs: valorTotalBs,
            metodo_pago: metodoPago,
            referencia_pago: referenciaPago,
            // comprobante_imagen: req.files && req.files.comprobante ? req.files.comprobante.name : null
            comprobante_imagen: null // Se agregará si se sube un archivo
        };

        // Manejar la subida del comprobante de pago si existe
        if (req.files && req.files.comprobante) {
            const comprobanteFile = req.files.comprobante;
            const fileExtension = path.extname(comprobanteFile.name);
            const fileName = `comprobante_${newCompra.id}_${Date.now()}${fileExtension}`;
            const filePath = path.join(COMPROBANTES_DIR, fileName);

            await comprobanteFile.mv(filePath); // Mover el archivo subido al directorio
            newCompra.comprobante_imagen = fileName; // Guardar el nombre del archivo en la compra
        }

        compras.push(newCompra);
        await writeJsonFile(COMPRAS_FILE, compras);

        // Actualizar el resumen de ventas (SALES_FILE)
        const saleExists = sales.find(s =>
            s.fecha_sorteo === currentDrawDate &&
            s.numero_sorteo_correlativo === currentCorrelativo &&
            s.numero_ticket === newTicketNumber
        );

        if (saleExists) {
            // Esto no debería pasar si numero_ticket es siempre único para un sorteo, pero como precaución
            saleExists.numeros.push(...numerosSeleccionados);
            saleExists.valor_usd += valorTotalUsd;
            saleExists.valor_bs += valorTotalBs;
        } else {
            sales.push({
                fecha_hora_compra: newCompra.fecha_hora_compra,
                fecha_sorteo: newCompra.fecha_sorteo,
                numero_sorteo_correlativo: newCompra.numero_sorteo_correlativo,
                numero_ticket: newCompra.numero_ticket,
                comprador: newCompra.comprador,
                telefono: newCompra.telefono,
                numeros: newCompra.numeros,
                valor_usd: newCompra.valor_usd,
                valor_bs: newCompra.valor_bs,
                metodo_pago: newCompra.metodo_pago,
                referencia_pago: newCompra.referencia_pago,
                comprobante_imagen: newCompra.comprobante_imagen
            });
        }
        await writeJsonFile(SALES_FILE, sales);

        // Enviar correo de notificación (opcional, si tienes EMAIL_USER y EMAIL_PASS configurados)
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER, // Envía al admin o al mismo usuario
                subject: 'Nueva Compra de Números',
                html: `
                    <h2>Nueva Compra Registrada</h2>
                    <p><strong>Comprador:</strong> ${nombreApellido}</p>
                    <p><strong>Teléfono:</strong> ${telefono}</p>
                    <p><strong>Números Seleccionados:</strong> ${numerosSeleccionados.join(', ')}</p>
                    <p><strong>Valor Total USD:</strong> $${valorTotalUsd.toFixed(2)}</p>
                    <p><strong>Valor Total Bs:</strong> Bs ${valorTotalBs.toFixed(2)}</p>
                    <p><strong>Método de Pago:</strong> ${metodoPago}</p>
                    <p><strong>Referencia:</strong> ${referenciaPago}</p>
                    <p><strong>Ticket Nro:</strong> ${newTicketNumber}</p>
                    <p><strong>Fecha Sorteo:</strong> ${currentDrawDate}</p>
                    <p><strong>Nro. Sorteo Correlativo:</strong> ${currentCorrelativo}</p>
                `,
            };
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    console.error('Error al enviar correo de notificación:', error);
                } else {
                    console.log('Correo de notificación enviado:', info.response);
                }
            });
        }

        res.status(200).json({ message: 'Compra registrada con éxito.', compra: newCompra });

    } catch (error) {
        console.error('Error al registrar compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar la compra.' });
    }
});


// 4. Rutas de Ventas (para el Panel de Administración)
// Ruta para obtener todas las ventas registradas
app.get('/ventas', async (req, res) => {
    try {
        const sales = await readJsonFile(SALES_FILE);
        res.json(sales);
    } catch (error) {
        console.error('Error al leer ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al cargar ventas.' });
    }
});

// Ruta para servir los comprobantes de pago
app.get('/comprobantes/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(COMPROBANTES_DIR, filename);
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error al enviar comprobante:', err);
            res.status(404).json({ message: 'Comprobante no encontrado.' });
        }
    });
});

// Ruta para realizar el corte de ventas (mueve ventas a histórico y reinicia números)
app.post('/cortar-ventas', async (req, res) => {
    try {
        const sales = await readJsonFile(SALES_FILE);
        const numbers = await readJsonFile(NUMBERS_FILE);
        const config = await readJsonFile(CONFIG_FILE);

        // Guardar ventas actuales en un archivo histórico (opcional, pero buena práctica)
        const historyFile = path.join(DATA_DIR, `ventas_historico_${moment().tz("America/Caracas").format('YYYYMMDD_HHmmss')}.json`);
        await writeJsonFile(historyFile, sales);
        console.log(`Ventas actuales guardadas en: ${historyFile}`);

        // Reiniciar números vendidos y ventas
        await writeJsonFile(NUMBERS_FILE, []); // Vaciar números vendidos
        await writeJsonFile(SALES_FILE, []);   // Vaciar ventas actuales

        // Actualizar fecha de sorteo y correlativo para el próximo sorteo
        const today = moment().tz("America/Caracas");
        const nextDrawDate = today.add(1, 'days').format('YYYY-MM-DD'); // El próximo sorteo es mañana
        config.fecha_sorteo = nextDrawDate;
        config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
        config.ultimo_numero_ticket = 0; // Reiniciar el contador de ticket para el nuevo sorteo
        await writeJsonFile(CONFIG_FILE, config);

        res.json({ message: 'Corte de ventas realizado con éxito. Números y ventas reiniciados. Fecha de sorteo actualizada.' });
    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar el corte de ventas.' });
    }
});

// Ruta para exportar todas las ventas a Excel
app.get('/exportar-excel', async (req, res) => {
    try {
        const sales = await readJsonFile(SALES_FILE);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        // Columnas
        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 10 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 10 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Números', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Comprobante', key: 'comprobante_imagen', width: 25 },
        ];

        // Añadir filas
        sales.forEach(sale => {
            worksheet.addRow({
                ...sale,
                numeros: sale.numeros ? sale.numeros.join(', ') : '',
                comprobante_imagen: sale.comprobante_imagen ? `${API_BASE_URL}/comprobantes/${sale.comprobante_imagen}` : ''
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Reporte_Ventas.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas a Excel.' });
    }
});


// --- Tareas programadas (cron jobs) ---
// Tarea para reiniciar números, ventas y actualizar fecha de sorteo a la medianoche (hora de Caracas)
cron.schedule('0 0 * * *', async () => { // Se ejecuta todos los días a las 00:00 (medianoche)
    console.log('Ejecutando tarea programada: Corte de ventas y reinicio de números.');
    try {
        let config = await readJsonFile(CONFIG_FILE);
        const today = moment().tz("America/Caracas").format('YYYY-MM-DD');
        const currentDrawDate = config.fecha_sorteo;

        // Solo reiniciar si la fecha del sorteo es HOY o anterior
        if (currentDrawDate <= today) {
            await writeJsonFile(NUMBERS_FILE, []); // Vaciar números vendidos
            await writeJsonFile(SALES_FILE, []);   // Vaciar ventas actuales
            console.log('Números y ventas reiniciados por tarea programada.');

            // Actualizar fecha de sorteo y correlativo
            config.fecha_sorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');
            config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
            config.ultimo_numero_ticket = 0; // Reiniciar el contador de ticket para el nuevo sorteo
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.ultimo_numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${today}).`);
        }

    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas" // Asegura que se ejecute en la zona horaria de Caracas
});


// --- Inicialización del servidor ---
// Asegura que los directorios y archivos de datos existan antes de iniciar el servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
            console.log(`Plataforma de usuario disponible en: https://tuoportunidadeshoy.netlify.app`);
        });
    }).catch(error => {
        console.error("Error fatal al iniciar el servidor (carga de datos):", error);
        process.exit(1); // Salir si hay un error en la carga inicial de datos
    });
}).catch(error => {
    console.error("Error fatal al iniciar el servidor (directorios):", error);
    process.exit(1); // Salir si hay un error al asegurar los directorios
});