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
}));

// Rutas a los archivos JSON en la misma raíz
const NUMEROS_FILE = 'numeros.json';
const VENTAS_FILE = 'ventas.json';
const CONFIG_FILE = 'configuracion.json';
const COMPROBANTES_FILE = 'comprobantes.json';
const RESULTADOS_ZULIA_FILE = 'resultados_zulia.json';
const HORARIOS_ZULIA_FILE = 'horarios_zulia.json';

// Directorio para guardar los comprobantes de pago
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// --- Funciones de Utilidad para manejo de archivos JSON ---
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(path.join(__dirname, filePath), 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // File not found
            if (filePath === NUMEROS_FILE) {
                // Si numeros.json no existe, inicializar con 1000 números
                const initialNumbers = Array.from({ length: 1000 }, (_, i) => ({
                    numero: String(i).padStart(3, '0'),
                    comprado: false,
                    comprador: null,
                    telefono: null,
                    fecha_compra: null,
                    metodo_pago: null,
                    referencia_pago: null,
                    ticket_id: null // Añadir ticket_id
                }));
                await writeJsonFile(NUMEROS_FILE, initialNumbers);
                return initialNumbers;
            } else if (filePath === CONFIG_FILE) {
                // Si configuracion.json no existe, inicializar con valores por defecto
                const defaultConfig = {
                    tasa_dolar: 36.5,
                    pagina_bloqueada: false,
                    fecha_sorteo: moment().tz("America/Caracas").format('YYYY-MM-DD'),
                    hora_sorteo: "07:00 PM", // Hora por defecto
                    precio_ticket: 1.00,
                    numero_sorteo_correlativo: 1,
                    ultimo_numero_ticket: 0,
                    ultima_fecha_resultados_zulia: null,
                    admin_whatsapp_numbers: [],
                    mail_config: {
                        host: "smtp.gmail.com",
                        port: 465,
                        secure: true,
                        user: "",
                        pass: "",
                        senderName: "Sistema de Rifas"
                    },
                    admin_email_for_reports: ""
                };
                await writeJsonFile(CONFIG_FILE, defaultConfig);
                return defaultConfig;
            } else if (filePath === VENTAS_FILE || filePath === COMPROBANTES_FILE || filePath === RESULTADOS_ZULIA_FILE || filePath === HORARIOS_ZULIA_FILE) {
                await writeJsonFile(filePath, []); // Archivos que pueden empezar vacíos
                return [];
            }
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(path.join(__dirname, filePath), JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir en el archivo ${filePath}:`, error);
        throw error;
    }
}

// Función para asegurar que el directorio de uploads exista
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        // Asegurarse de que los archivos JSON base existan
        await readJsonFile(NUMEROS_FILE);
        await readJsonFile(VENTAS_FILE);
        await readJsonFile(CONFIG_FILE);
        await readJsonFile(COMPROBANTES_FILE);
        await readJsonFile(RESULTADOS_ZULIA_FILE);
        await readJsonFile(HORARIOS_ZULIA_FILE);
        console.log('Directorios y archivos JSON base asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios o archivos JSON:', error);
    }
}

// Función para cargar datos iniciales en memoria (si es necesario)
async function loadInitialData() {
    try {
        // En una aplicación real, aquí podrías cargar datos en una base de datos o en memoria si el tamaño lo permite.
        // Para este proyecto, simplemente nos aseguramos de que los archivos existan.
        console.log('Datos iniciales cargados (archivos JSON asegurados).');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
    }
}

// --- Middlewares ---
// Este middleware es solo para ejemplo de autenticación básica de admin
const authenticateAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey && adminKey === process.env.ADMIN_KEY) {
        next();
    } else {
        res.status(401).json({ message: 'Acceso no autorizado al panel de administración.' });
    }
};

// --- Rutas de la API (Públicas - Frontend Cliente) ---

// Obtener todos los números disponibles (para la grilla del frontend)
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE);
        res.json(numeros);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener los números.' });
    }
});

// --- NUEVO ENDPOINT PARA EL FRONTEND: /api/config ---
// Obtener la configuración pública para el frontend
app.get('/api/config', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        
        // Adaptar los nombres de las propiedades para el frontend
        // El frontend espera 'precio_usd', 'precio_bs', 'fecha_sorteo', 'hora_sorteo', 'pagina_bloqueada'
        const publicConfig = {
            tasa_dolar: config.tasa_dolar,
            pagina_bloqueada: config.pagina_bloqueada,
            fecha_sorteo: config.fecha_sorteo,
            hora_sorteo: config.hora_sorteo, // Asegúrate de que hora_sorteo esté en tu configuracion.json
            precio_usd: config.precio_ticket,
            precio_bs: config.precio_ticket * config.tasa_dolar
        };
        res.json(publicConfig);
    } catch (error) {
        console.error('Error al leer el archivo de configuración para el frontend:', error);
        res.status(500).json({ message: 'Error interno del servidor al cargar la configuración pública.' });
    }
});
// --- FIN DEL NUEVO ENDPOINT ---

// Ruta para procesar la compra de números
app.post('/api/comprar', async (req, res) => {
    const { numeros, nombre_apellido, telefono, metodo_pago, referencia_pago } = req.body;

    if (!numeros || !Array.isArray(numeros) || numeros.length === 0 || !nombre_apellido || !telefono || !metodo_pago || !referencia_pago) {
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra.' });
    }

    try {
        let allNumbers = await readJsonFile(NUMEROS_FILE);
        let config = await readJsonFile(CONFIG_FILE);
        let ventas = await readJsonFile(VENTAS_FILE);

        const now = moment().tz("America/Caracas");
        const fechaCompra = now.format('YYYY-MM-DD');
        const horaCompra = now.format('HH:mm:ss');
        const ticketId = `T${config.numero_sorteo_correlativo}-${String(config.ultimo_numero_ticket + 1).padStart(6, '0')}`; // Nuevo ID de ticket

        const numerosCompradosDetalles = [];
        const numerosNoDisponibles = [];

        for (const num of numeros) {
            const numeroIndex = allNumbers.findIndex(n => n.numero === num);
            if (numeroIndex !== -1 && !allNumbers[numeroIndex].comprado) {
                allNumbers[numeroIndex].comprado = true;
                allNumbers[numeroIndex].comprador = nombre_apellido;
                allNumbers[numeroIndex].telefono = telefono;
                allNumbers[numeroIndex].fecha_compra = fechaCompra;
                allNumbers[numeroIndex].hora_compra = horaCompra; // Guardar hora de compra
                allNumbers[numeroIndex].metodo_pago = metodo_pago;
                allNumbers[numeroIndex].referencia_pago = referencia_pago;
                allNumbers[numeroIndex].ticket_id = ticketId; // Asignar el ticket_id
                numerosCompradosDetalles.push(allNumbers[numeroIndex]);
            } else {
                numerosNoDisponibles.push(num);
            }
        }

        if (numerosNoDisponibles.length > 0) {
            return res.status(409).json({ message: `Algunos números no están disponibles: ${numerosNoDisponibles.join(', ')}` });
        }

        if (numerosCompradosDetalles.length === 0) {
            return res.status(400).json({ message: 'No se pudieron comprar los números seleccionados.' });
        }

        await writeJsonFile(NUMEROS_FILE, allNumbers);

        const totalUsd = numeros.length * config.precio_ticket;
        const totalBs = totalUsd * config.tasa_dolar;

        const nuevaVenta = {
            id: ventas.length > 0 ? Math.max(...ventas.map(v => v.id)) + 1 : 1,
            ticket_id: ticketId,
            fecha: fechaCompra,
            hora: horaCompra,
            nombre_apellido,
            telefono,
            numeros: numeros,
            total_usd: totalUsd,
            total_bs: totalBs,
            metodo_pago,
            referencia_pago,
            estado: 'Completada', // Opcional: para seguimiento
            fecha_sorteo: config.fecha_sorteo,
            hora_sorteo: config.hora_sorteo // Añadir hora del sorteo
        };
        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);

        // Actualizar el correlativo del último número de ticket
        config.ultimo_numero_ticket += numeros.length;
        await writeJsonFile(CONFIG_FILE, config);

        res.status(200).json({
            message: 'Compra realizada con éxito!',
            numeros_comprados: numeros,
            nombre_apellido,
            telefono,
            metodo_pago,
            referencia_pago,
            total_usd: totalUsd,
            total_bs: totalBs,
            ticket_id: ticketId,
            fecha_sorteo: config.fecha_sorteo,
            hora_sorteo: config.hora_sorteo
        });

    } catch (error) {
        console.error('Error en la compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.' });
    }
});

// Obtener todas las ventas (para el admin)
app.get('/api/ventas', authenticateAdmin, async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        res.json(ventas);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener las ventas.' });
    }
});


// --- Rutas del Panel de Administración ---

// Obtener la configuración (para el panel de administración)
app.get('/api/admin/config', authenticateAdmin, async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la configuración de administración.' });
    }
});

// Actualizar la configuración (para el panel de administración)
app.put('/api/admin/config', authenticateAdmin, async (req, res) => {
    const { tasa_dolar, pagina_bloqueada, precio_ticket, numero_sorteo_correlativo, ultimo_numero_ticket, admin_whatsapp_numbers, mail_config, admin_email_for_reports } = req.body;
    try {
        let config = await readJsonFile(CONFIG_FILE);

        // Actualizar solo los campos que se envían y son válidos
        if (tasa_dolar !== undefined && typeof tasa_dolar === 'number') config.tasa_dolar = tasa_dolar;
        if (pagina_bloqueada !== undefined && typeof pagina_bloqueada === 'boolean') config.pagina_bloqueada = pagina_bloqueada;
        if (precio_ticket !== undefined && typeof precio_ticket === 'number') config.precio_ticket = precio_ticket;
        if (numero_sorteo_correlativo !== undefined && typeof numero_sorteo_correlativo === 'number') config.numero_sorteo_correlativo = numero_sorteo_correlativo;
        if (ultimo_numero_ticket !== undefined && typeof ultimo_numero_ticket === 'number') config.ultimo_numero_ticket = ultimo_numero_ticket;
        if (admin_whatsapp_numbers !== undefined && Array.isArray(admin_whatsapp_numbers)) config.admin_whatsapp_numbers = admin_whatsapp_numbers;
        if (mail_config !== undefined && typeof mail_config === 'object') config.mail_config = { ...config.mail_config, ...mail_config };
        if (admin_email_for_reports !== undefined && typeof admin_email_for_reports === 'string') config.admin_email_for_reports = admin_email_for_reports;
        
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Configuración actualizada con éxito', config });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar la configuración.' });
    }
});


// Obtener números (para el panel de administración, permite ver comprador etc)
app.get('/api/admin/numeros', authenticateAdmin, async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE);
        res.json(numeros);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener los números para administración.' });
    }
});

// Eliminar un número específico (admin)
app.delete('/api/admin/numeros/:numero', authenticateAdmin, async (req, res) => {
    const numeroAEliminar = req.params.numero;
    try {
        let numeros = await readJsonFile(NUMEROS_FILE);
        const numeroIndex = numeros.findIndex(n => n.numero === numeroAEliminar);

        if (numeroIndex === -1) {
            return res.status(404).json({ message: 'Número no encontrado.' });
        }

        // Marcar como no comprado, eliminar detalles del comprador
        numeros[numeroIndex].comprado = false;
        numeros[numeroIndex].comprador = null;
        numeros[numeroIndex].telefono = null;
        numeros[numeroIndex].fecha_compra = null;
        numeros[numeroIndex].hora_compra = null;
        numeros[numeroIndex].metodo_pago = null;
        numeros[numeroIndex].referencia_pago = null;
        numeros[numeroIndex].ticket_id = null;

        await writeJsonFile(NUMEROS_FILE, numeros);
        res.json({ message: `Número ${numeroAEliminar} liberado con éxito.`, numero: numeros[numeroIndex] });
    } catch (error) {
        console.error('Error al eliminar número:', error);
        res.status(500).json({ message: 'Error interno del servidor al liberar el número.' });
    }
});

// Resetear todos los números (admin)
app.post('/api/admin/reset_numeros', authenticateAdmin, async (req, res) => {
    try {
        const initialNumbers = Array.from({ length: 1000 }, (_, i) => ({
            numero: String(i).padStart(3, '0'),
            comprado: false,
            comprador: null,
            telefono: null,
            fecha_compra: null,
            metodo_pago: null,
            referencia_pago: null,
            ticket_id: null
        }));
        await writeJsonFile(NUMEROS_FILE, initialNumbers);

        // Opcional: también resetear ventas, comprobantes y correlativos si se requiere un reseteo completo
        // await writeJsonFile(VENTAS_FILE, []);
        // await writeJsonFile(COMPROBANTES_FILE, []);
        // let config = await readJsonFile(CONFIG_FILE);
        // config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementar correlativo
        // config.ultimo_numero_ticket = 0; // Reiniciar
        // await writeJsonFile(CONFIG_FILE, config);

        res.json({ message: 'Todos los números han sido reseteados a no comprados.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al resetear los números.' });
    }
});

// Cargar comprobantes de pago (admin)
app.post('/api/admin/upload_comprobante', authenticateAdmin, async (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se subió ningún archivo.' });
    }

    const { comprobanteFile } = req.files;
    const { comprador, telefono } = req.body;

    if (!comprador || !telefono) {
        return res.status(400).json({ message: 'Faltan datos del comprador (nombre y teléfono).' });
    }

    const uploadPath = path.join(UPLOAD_DIR, comprobanteFile.name);

    try {
        await comprobanteFile.mv(uploadPath);
        let comprobantes = await readJsonFile(COMPROBANTES_FILE);
        const newComprobante = {
            id: comprobantes.length > 0 ? Math.max(...comprobantes.map(c => c.id)) + 1 : 1,
            comprador,
            telefono,
            comprobante_nombre: comprobanteFile.name,
            comprobante_tipo: comprobanteFile.mimetype,
            fecha_subida: moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss')
        };
        comprobantes.push(newComprobante);
        await writeJsonFile(COMPROBANTES_FILE, comprobantes);

        res.json({ message: 'Comprobante subido y registrado con éxito', filename: comprobanteFile.name });
    } catch (error) {
        console.error('Error al subir el comprobante:', error);
        res.status(500).json({ message: 'Error al subir el comprobante.' });
    }
});

// Servir archivos subidos (comprobantes)
app.use('/uploads', express.static(UPLOAD_DIR));

// Obtener lista de comprobantes (admin)
app.get('/api/admin/comprobantes', authenticateAdmin, async (req, res) => {
    try {
        const comprobantes = await readJsonFile(COMPROBANTES_FILE);
        res.json(comprobantes);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la lista de comprobantes.' });
    }
});

// Eliminar un comprobante (admin)
app.delete('/api/admin/comprobantes/:id', authenticateAdmin, async (req, res) => {
    const comprobanteId = parseInt(req.params.id);
    try {
        let comprobantes = await readJsonFile(COMPROBANTES_FILE);
        const initialLength = comprobantes.length;
        comprobantes = comprobantes.filter(c => c.id !== comprobanteId);

        if (comprobantes.length === initialLength) {
            return res.status(404).json({ message: 'Comprobante no encontrado.' });
        }

        // Opcional: Eliminar el archivo físico del comprobante
        // const comprobante = comprobantes.find(c => c.id === comprobanteId);
        // if (comprobante && comprobante.comprobante_nombre) {
        //     const filePath = path.join(UPLOAD_DIR, comprobante.comprobante_nombre);
        //     await fs.unlink(filePath).catch(err => console.error(`Error al eliminar archivo físico: ${filePath}`, err));
        // }

        await writeJsonFile(COMPROBANTES_FILE, comprobantes);
        res.json({ message: 'Comprobante eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar el comprobante:', error);
        res.status(500).json({ message: 'Error interno del servidor al eliminar el comprobante.' });
    }
});

// Descargar reporte de ventas en Excel (admin)
app.get('/api/admin/download_sales', authenticateAdmin, async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        const config = await readJsonFile(CONFIG_FILE);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Ventas');

        // Añadir cabeceras
        worksheet.columns = [
            { header: 'Ticket ID', key: 'ticket_id', width: 15 },
            { header: 'Fecha', key: 'fecha', width: 12 },
            { header: 'Hora', key: 'hora', width: 10 },
            { header: 'Nombre', key: 'nombre_apellido', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números Comprados', key: 'numeros_str', width: 40 },
            { header: 'Total USD', key: 'total_usd', width: 15 },
            { header: 'Total Bs', key: 'total_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia de Pago', key: 'referencia_pago', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Hora Sorteo', key: 'hora_sorteo', width: 15 }
        ];

        // Añadir filas
        ventas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros_str: venta.numeros.join(', ') // Convertir array de números a string
            });
        });

        // Configurar respuesta HTTP
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte_ventas.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al generar el reporte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el reporte.' });
    }
});


// Enviar reporte de ventas por correo (admin)
app.post('/api/admin/send_excel_report', authenticateAdmin, async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        const config = await readJsonFile(CONFIG_FILE);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte de Ventas');

        worksheet.columns = [
            { header: 'Ticket ID', key: 'ticket_id', width: 15 },
            { header: 'Fecha', key: 'fecha', width: 12 },
            { header: 'Hora', key: 'hora', width: 10 },
            { header: 'Nombre', key: 'nombre_apellido', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números Comprados', key: 'numeros_str', width: 40 },
            { header: 'Total USD', key: 'total_usd', width: 15 },
            { header: 'Total Bs', key: 'total_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia de Pago', key: 'referencia_pago', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Hora Sorteo', key: 'hora_sorteo', width: 15 }
        ];

        ventas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros_str: venta.numeros.join(', ')
            });
        });

        const buffer = await workbook.xlsx.writeBuffer();

        const transporter = nodemailer.createTransport({
            host: config.mail_config.host,
            port: config.mail_config.port,
            secure: config.mail_config.secure,
            auth: {
                user: config.mail_config.user,
                pass: config.mail_config.pass,
            },
        });

        const mailOptions = {
            from: `"${config.mail_config.senderName}" <${config.mail_config.user}>`,
            to: config.admin_email_for_reports,
            subject: `Reporte de Ventas - ${moment().tz("America/Caracas").format('DD-MM-YYYY HH:mm')}`,
            html: `
                <p>Estimado administrador,</p>
                <p>Adjunto encontrará el reporte de ventas actualizado hasta la fecha y hora de envío.</p>
                <p>Saludos cordiales,</p>
                <p>Su Sistema de Rifas</p>
            `,
            attachments: [
                {
                    filename: `reporte_ventas_${moment().tz("America/Caracas").format('YYYYMMDD_HHmmss')}.xlsx`,
                    content: buffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                },
            ],
        };

        await transporter.sendMail(mailOptions);
        res.json({ message: 'Reporte de ventas enviado por correo con éxito.' });

    } catch (error) {
        console.error('Error al enviar el reporte de ventas por correo:', error);
        res.status(500).json({ message: 'Error interno del servidor al enviar el reporte.' });
    }
});


// Obtener resultados del Zulia
app.get('/api/admin/resultados-zulia', authenticateAdmin, async (req, res) => {
    try {
        const resultados = await readJsonFile(RESULTADOS_ZULIA_FILE);
        res.json(resultados);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener resultados del Zulia.' });
    }
});

// Guardar resultados del Zulia
app.post('/api/admin/resultados-zulia', authenticateAdmin, async (req, res) => {
    const { fecha, resultados } = req.body; // resultados esperado como { "12:00 PM": "XXX", "04:00 PM": "YYY", "07:00 PM": "ZZZ" }
    if (!fecha || !resultados || typeof resultados !== 'object') {
        return res.status(400).json({ message: 'Datos incompletos para guardar resultados del Zulia.' });
    }
    try {
        let allResultados = await readJsonFile(RESULTADOS_ZULIA_FILE);
        const existingIndex = allResultados.findIndex(r => r.fecha === fecha);
        if (existingIndex !== -1) {
            allResultados[existingIndex].resultados = { ...allResultados[existingIndex].resultados, ...resultados }; // Fusionar resultados
        } else {
            allResultados.push({ fecha, resultados });
        }
        await writeJsonFile(RESULTADOS_ZULIA_FILE, allResultados);

        // Actualizar ultima_fecha_resultados_zulia en configuracion.json
        let config = await readJsonFile(CONFIG_FILE);
        config.ultima_fecha_resultados_zulia = fecha;
        await writeJsonFile(CONFIG_FILE, config);

        res.json({ message: 'Resultados del Zulia guardados con éxito.' });
    } catch (error) {
        console.error('Error al guardar resultados del Zulia:', error);
        res.status(500).json({ message: 'Error al guardar resultados del Zulia.' });
    }
});


// Obtener horarios de Zulia
app.get('/api/admin/horarios-zulia', authenticateAdmin, async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener horarios del Zulia.' });
    }
});

// Guardar horarios de Zulia
app.post('/api/admin/horarios-zulia', authenticateAdmin, async (req, res) => {
    const { horarios_zulia } = req.body; // Esperado como un array de strings ["12:00 PM", "04:00 PM"]
    if (!horarios_zulia || !Array.isArray(horarios_zulia)) {
        return res.status(400).json({ message: 'Datos incompletos para guardar horarios del Zulia.' });
    }
    try {
        await writeJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia });
        res.json({ message: 'Horarios del Zulia guardados con éxito.' });
    } catch (error) {
        console.error('Error al guardar horarios del Zulia:', error);
        res.status(500).json({ message: 'Error al guardar horarios del Zulia.' });
    }
});

// Actualizar precios (admin)
app.post('/api/admin/actualizar-precios', authenticateAdmin, async (req, res) => {
    const { precio_usd, tasa_dolar } = req.body;
    try {
        let config = await readJsonFile(CONFIG_FILE);
        if (precio_usd !== undefined && typeof precio_usd === 'number') {
            config.precio_ticket = precio_usd; // Asumo que precio_ticket es el precio en USD
        }
        if (tasa_dolar !== undefined && typeof tasa_dolar === 'number') {
            config.tasa_dolar = tasa_dolar;
        }
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Precios actualizados con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar precios:', error);
        res.status(500).json({ message: 'Error al actualizar precios.' });
    }
});

// Bloquear/Desbloquear página (admin)
app.post('/api/admin/bloquear-pagina', authenticateAdmin, async (req, res) => {
    const { blocked } = req.body; // `blocked` debe ser un booleano
    if (typeof blocked !== 'boolean') {
        return res.status(400).json({ message: 'El valor de "blocked" debe ser un booleano.' });
    }
    try {
        let config = await readJsonFile(CONFIG_FILE);
        config.pagina_bloqueada = blocked;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: `Página ${blocked ? 'bloqueada' : 'desbloqueada'} con éxito.`, config });
    } catch (error) {
        console.error('Error al bloquear/desbloquear página:', error);
        res.status(500).json({ message: 'Error al cambiar el estado de la página.' });
    }
});

// Activar/Desactivar panel de administración (No implementado en config.json, pero podría ser una feature)
// Esto requiere una lógica diferente, tal vez una variable de entorno o un archivo de configuración separado para el estado del panel de admin
app.post('/api/admin/toggle-admin-panel', authenticateAdmin, async (req, res) => {
    // Esto sería más complejo, ya que el panel de admin mismo es el que hace la autenticación.
    // Podría ser para una URL diferente o un mecanismo de bypass.
    // Por ahora, solo es un placeholder.
    res.status(501).json({ message: 'Esta funcionalidad no está implementada para el panel de administración.' });
});

// Establecer fecha de sorteo (admin)
app.post('/api/admin/set-draw-date', authenticateAdmin, async (req, res) => {
    const { fecha_sorteo } = req.body; // Formato YYYY-MM-DD
    if (!fecha_sorteo || !moment(fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Formato de fecha de sorteo inválido. Use YYYY-MM-DD.' });
    }
    try {
        let config = await readJsonFile(CONFIG_FILE);
        config.fecha_sorteo = fecha_sorteo;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Fecha de sorteo actualizada con éxito.', config });
    } catch (error) {
        console.error('Error al establecer fecha de sorteo:', error);
        res.status(500).json({ message: 'Error al establecer fecha de sorteo.' });
    }
});

// Establecer hora de sorteo (admin)
app.post('/api/admin/set-draw-hour', authenticateAdmin, async (req, res) => {
    const { hora_sorteo } = req.body; // Formato HH:mm AM/PM (Ej: "07:00 PM")
    // Validación básica de formato de hora, puedes mejorarla si es necesario
    if (!hora_sorteo || typeof hora_sorteo !== 'string' || !hora_sorteo.match(/^(1[0-2]|0?[1-9]):([0-5][0-9]) (AM|PM)$/i)) {
        return res.status(400).json({ message: 'Formato de hora de sorteo inválido. Use HH:mm AM/PM (ej: 07:00 PM).' });
    }
    try {
        let config = await readJsonFile(CONFIG_FILE);
        config.hora_sorteo = hora_sorteo;
        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Hora de sorteo actualizada con éxito.', config });
    } catch (error) {
        console.error('Error al establecer hora de sorteo:', error);
        res.status(500).json({ message: 'Error al establecer hora de sorteo.' });
    }
});

// Generar reporte PDF (admin)
app.get('/api/admin/generar-reporte-pdf', authenticateAdmin, async (req, res) => {
    // Esta función requeriría una librería como 'puppeteer' o 'pdfkit' para generar PDFs
    // Es una funcionalidad más avanzada que no está implementada con los paquetes actuales
    res.status(501).json({ message: 'Generación de reporte PDF no implementada.' });
});

// Enviar mensaje de WhatsApp (admin)
app.post('/api/admin/send-whatsapp-message', authenticateAdmin, async (req, res) => {
    const { message, number } = req.body;
    if (!message || !number) {
        return res.status(400).json({ message: 'Mensaje y número son requeridos.' });
    }
    // NOTA: Para enviar mensajes de WhatsApp desde el backend, necesitarías una API de WhatsApp oficial
    // (Twilio, Vonage, WhatsApp Business API) o una solución de terceros.
    // Esto es solo un placeholder para la lógica del backend.
    try {
        console.log(`Simulando envío de WhatsApp a ${number}: ${message}`);
        res.json({ message: `Mensaje a ${number} enviado (simulado).` });
    } catch (error) {
        console.error('Error al enviar mensaje de WhatsApp:', error);
        res.status(500).json({ message: 'Error al enviar mensaje de WhatsApp.' });
    }
});

// --- Tareas Programadas (CRON Jobs) ---

// Tarea programada para el corte de ventas y reinicio diario (Ej: a las 12:00 AM hora de Venezuela)
cron.schedule('0 0 * * *', async () => {
    console.log('Ejecutando tarea programada: Corte de ventas y reinicio de números.');
    try {
        let config = await readJsonFile(CONFIG_FILE);
        const today = moment().tz("America/Caracas");
        const todayFormatted = today.format('YYYY-MM-DD');
        const currentDrawDate = config.fecha_sorteo;

        // Si la fecha del sorteo actual es anterior o igual a la fecha de hoy, es hora de cortar y reiniciar
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted, 'day')) {
            console.log(`Fecha de sorteo (${currentDrawDate}) es anterior o igual a hoy (${todayFormatted}). Reiniciando números...`);

            // 1. Guardar los números vendidos en un histórico si es necesario (no implementado, pero buena idea)
            // 2. Resetear todos los números a "no comprado"
            const initialNumbers = Array.from({ length: 1000 }, (_, i) => ({
                numero: String(i).padStart(3, '0'),
                comprado: false,
                comprador: null,
                telefono: null,
                fecha_compra: null,
                metodo_pago: null,
                referencia_pago: null,
                ticket_id: null // Reiniciar ticket_id para los números
            }));
            await writeJsonFile(NUMEROS_FILE, initialNumbers);
            console.log('Todos los números han sido reseteados a no comprados.');

            // 3. Opcional: limpiar ventas.json o mover a un histórico de ventas completadas
            // await writeJsonFile(VENTAS_FILE, []); // Esto limpiaría el historial de ventas completamente

            // Actualizar la fecha del próximo sorteo a mañana y el correlativo
            config.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD');
            config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementar correlativo
            config.ultimo_numero_ticket = 0; // Reiniciar el último número de ticket usado
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.numero_sorteo_correlativo}.`);
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
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`); // Reemplaza con tu URL real
        });
    }).catch(err => {
        console.error("Error al cargar datos iniciales:", err);
        process.exit(1); // Salir si los datos iniciales no se pueden cargar
    });
}).catch(err => {
    console.error("Error al asegurar directorios/archivos JSON al inicio:", err);
    process.exit(1); // Salir si no se pueden crear directorios/archivos esenciales
});