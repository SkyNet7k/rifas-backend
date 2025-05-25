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
        'https://paneladmin01.netlify.app', // <--- ¡AÑADIDO ESTE ORIGEN!
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
app.use(fileUpload());

const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');

// Función para leer archivos JSON
async function readJsonFile(filePath, defaultContent = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2));
            return defaultContent;
        }
        throw error;
    }
}

// Función para escribir archivos JSON
async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Asegurarse de que el directorio de comprobantes exista
async function ensureComprobantesDir() {
    try {
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error('Error al crear directorio de comprobantes:', error);
        }
    }
}

// --- Rutas de la API ---

// Ruta para obtener y actualizar la configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        console.error('Error al leer configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

app.post('/api/configuracion', async (req, res) => {
    try {
        let config = await readJsonFile(CONFIG_FILE);
        const updatedConfig = req.body;

        // Validar y aplicar solo los campos permitidos
        if (updatedConfig.hasOwnProperty('tasa_dolar')) {
            config.tasa_dolar = parseFloat(updatedConfig.tasa_dolar);
        }
        if (updatedConfig.hasOwnProperty('pagina_bloqueada')) {
            config.pagina_bloqueada = updatedConfig.pagina_bloqueada === 'true'; // Asegurarse que sea booleano
        }
        if (updatedConfig.hasOwnProperty('mensaje_bloqueo')) {
            config.mensaje_bloqueo = updatedConfig.mensaje_bloqueo;
        }
        if (updatedConfig.hasOwnProperty('fecha_sorteo')) {
            // Asegurarse que la fecha sea válida y esté en formato YYYY-MM-DD
            const fechaValida = moment(updatedConfig.fecha_sorteo, 'YYYY-MM-DD').isValid();
            if (fechaValida) {
                config.fecha_sorteo = updatedConfig.fecha_sorteo;
            } else {
                return res.status(400).json({ message: 'Formato de fecha de sorteo inválido. Use YYYY-MM-DD.' });
            }
        }
        if (updatedConfig.hasOwnProperty('precio_ticket')) {
            config.precio_ticket = parseFloat(updatedConfig.precio_ticket);
        }
        if (updatedConfig.hasOwnProperty('numero_sorteo_correlativo')) {
            config.numero_sorteo_correlativo = parseInt(updatedConfig.numero_sorteo_correlativo);
        }
        if (updatedConfig.hasOwnProperty('admin_whatsapp_numbers')) {
            // Asegúrate de que los números sean un array de strings y estén limpios
            const numbers = updatedConfig.admin_whatsapp_numbers
                                .split(',')
                                .map(n => n.trim())
                                .filter(n => n.length > 0);
            config.admin_whatsapp_numbers = numbers;
        }

        // Configuración de correo
        if (updatedConfig.hasOwnProperty('mail_config')) {
            config.mail_config = {
                host: updatedConfig.mail_config.host,
                port: parseInt(updatedConfig.mail_config.port),
                secure: updatedConfig.mail_config.secure === 'true' || updatedConfig.mail_config.secure === true,
                user: updatedConfig.mail_config.user,
                pass: updatedConfig.mail_config.pass,
                senderName: updatedConfig.mail_config.senderName
            };
        }
        // Email para reportes
        if (updatedConfig.hasOwnProperty('admin_email_for_reports')) {
            config.admin_email_for_reports = updatedConfig.admin_email_for_reports;
        }

        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Configuración actualizada con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});

// Rutas para números
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE, Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        })));
        res.json(numeros);
    } catch (error) {
        console.error('Error al leer números:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.' });
    }
});

app.post('/api/numeros/reiniciar', async (req, res) => {
    try {
        const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
        res.json({ message: 'Números reiniciados a disponibles con éxito.' });
    } catch (error) {
        console.error('Error al reiniciar números:', error);
        res.status(500).json({ message: 'Error interno del servidor al reiniciar números.' });
    }
});

app.post('/api/numeros/comprar', async (req, res) => {
    try {
        const { numerosSeleccionados, comprador, telefono, cedula, email, metodoPago, referenciaPago, valorTotalUsd, valorTotalBs, comprobanteNombre } = req.body;

        if (!numerosSeleccionados || numerosSeleccionados.length === 0) {
            return res.status(400).json({ message: 'No se han seleccionado números para comprar.' });
        }

        let numeros = await readJsonFile(NUMEROS_FILE, Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        })));
        let ventas = await readJsonFile(VENTAS_FILE, []);
        let config = await readJsonFile(CONFIG_FILE);

        const numerosNoDisponibles = numerosSeleccionados.filter(n => numeros.find(num => num.numero === n && num.comprado));
        if (numerosNoDisponibles.length > 0) {
            return res.status(400).json({ message: `Los números ${numerosNoDisponibles.join(', ')} ya han sido comprados.` });
        }

        // Incrementar el último número de ticket y el número de sorteo si es necesario
        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        const ticketId = config.ultimo_numero_ticket;

        const fechaCompra = moment().tz('America/Caracas').format('YYYY-MM-DD HH:mm:ss');
        const fechaSorteo = config.fecha_sorteo;
        const numeroSorteoCorrelativo = config.numero_sorteo_correlativo;


        const nuevaVenta = {
            id: Date.now(), // Un ID único para la venta
            fecha_hora_compra: fechaCompra,
            fecha_sorteo: fechaSorteo,
            numero_sorteo_correlativo: numeroSorteoCorrelativo,
            numero_ticket: ticketId,
            comprador,
            telefono,
            cedula: cedula || null,
            email: email || null,
            numeros: numerosSeleccionados,
            valor_usd: valorTotalUsd,
            valor_bs: valorTotalBs,
            metodo_pago: metodoPago,
            referencia_pago: referenciaPago,
            comprobante_nombre: comprobanteNombre || null
        };

        // Marcar los números como comprados
        numerosSeleccionados.forEach(numSel => {
            const index = numeros.findIndex(n => n.numero === numSel);
            if (index !== -1) {
                numeros[index].comprado = true;
                numeros[index].comprador_info = {
                    nombre: comprador,
                    telefono: telefono,
                    fecha_compra: fechaCompra,
                    numero_ticket: ticketId
                };
            }
        });

        ventas.push(nuevaVenta);

        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(VENTAS_FILE, ventas);
        await writeJsonFile(CONFIG_FILE, config); // Guardar la configuración actualizada con el nuevo ticketId

        // Enviar correo de notificación (si la configuración de correo está presente)
        if (config.mail_config && config.mail_config.user && config.mail_config.pass) {
            try {
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
                    to: email, // Al cliente
                    bcc: config.admin_email_for_reports || config.mail_config.user, // Al administrador (si está configurado)
                    subject: `¡Confirmación de Compra de Rifa #${nuevaVenta.numero_ticket}!`,
                    html: `
                        <h2>¡Gracias por tu compra, ${comprador}!</h2>
                        <p>Tu compra de ticket de rifa ha sido confirmada con los siguientes detalles:</p>
                        <ul>
                            <li><strong>ID de Comprobante:</strong> ${nuevaVenta.id}</li>
                            <li><strong>Fecha y Hora de Compra:</strong> ${nuevaVenta.fecha_hora_compra}</li>
                            <li><strong>Sorteo:</strong> #${nuevaVenta.numero_sorteo_correlativo} (Fecha: ${nuevaVenta.fecha_sorteo})</li>
                            <li><strong>Número de Ticket:</strong> ${nuevaVenta.numero_ticket}</li>
                            <li><strong>Números Adquiridos:</strong> ${numerosSeleccionados.join(', ')}</li>
                            <li><strong>Total Pagado:</strong> $${nuevaVenta.valor_usd.toFixed(2)} (${nuevaVenta.valor_bs.toFixed(2)} Bs)</li>
                            <li><strong>Método de Pago:</strong> ${nuevaVenta.metodo_pago}</li>
                            <li><strong>Referencia de Pago:</strong> ${nuevaVenta.referencia_pago || 'N/A'}</li>
                        </ul>
                        <p>¡Mucha suerte en el sorteo!</p>
                        <p>Saludos cordiales,<br>El equipo de Rifas y Loterías</p>
                    `,
                };

                await transporter.sendMail(mailOptions);
                console.log(`Correo de confirmación enviado a ${email}`);
            } catch (mailError) {
                console.error('Error al enviar correo de confirmación:', mailError);
                // No bloquear la respuesta exitosa por un error de correo
            }
        }


        res.status(201).json({ message: 'Compra realizada con éxito', venta: nuevaVenta });
    } catch (error) {
        console.error('Error al procesar compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.' });
    }
});


// Ruta para subir comprobantes
app.post('/api/upload-comprobante', async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ message: 'No se subió ningún archivo.' });
        }

        let comprobanteFile = req.files.comprobante;
        const uploadPath = path.join(COMPROBANTES_DIR, comprobanteFile.name);

        await comprobanteFile.mv(uploadPath);
        res.json({ message: 'Archivo subido con éxito', fileName: comprobanteFile.name });
    } catch (error) {
        console.error('Error al subir el archivo:', error);
        res.status(500).json({ message: 'Error interno del servidor al subir el archivo.' });
    }
});

// Servir comprobantes estáticamente (IMPORTANTE para que el frontend pueda verlos)
app.use('/comprobantes', express.static(COMPROBANTES_DIR));


// Rutas para ventas
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        res.json(ventas);
    } catch (error) {
        console.error('Error al leer ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.' });
    }
});

app.post('/api/ventas/corte', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        if (ventas.length === 0) {
            return res.status(200).json({ message: 'No hay ventas para realizar el corte.' });
        }

        // Generar Excel y guardar/enviar
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Corte de Ventas');

        // Definir columnas con cabeceras amigables
        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 12 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 12 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Números Comprados', key: 'numeros', width: 25 },
            { header: 'Valor USD', key: 'valor_usd', width: 10 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Comprobante', key: 'comprobante_nombre', width: 30 }
        ];

        ventas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros: venta.numeros.join(', '), // Unir array de números para el Excel
            });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const timestamp = moment().tz('America/Caracas').format('YYYYMMDD_HHmmss');
        const filename = `Corte_de_Ventas_${timestamp}.xlsx`;
        const filepath = path.join(COMPROBANTES_DIR, filename); // Guardar en la carpeta de comprobantes

        await fs.writeFile(filepath, buffer);
        console.log(`Corte de ventas guardado en: ${filepath}`);

        // Enviar por correo si está configurado
        const config = await readJsonFile(CONFIG_FILE);
        const adminEmail = config.admin_email_for_reports;
        if (adminEmail && config.mail_config && config.mail_config.user && config.mail_config.pass) {
            try {
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
                    to: adminEmail,
                    subject: `Reporte de Corte de Ventas - ${moment().tz('America/Caracas').format('YYYY-MM-DD HH:mm')}`,
                    html: `
                        <p>Adjunto encontrarás el reporte de corte de ventas hasta la fecha y hora actual.</p>
                        <p>Total de ventas en este corte: <strong>${ventas.length}</strong></p>
                        <p>Este reporte incluye todas las ventas desde el último corte o el inicio del sistema.</p>
                        <p>Saludos cordiales,<br>Sistema de Rifas</p>
                    `,
                    attachments: [
                        {
                            filename: filename,
                            content: buffer,
                            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                        }
                    ]
                };
                await transporter.sendMail(mailOptions);
                console.log(`Correo de corte de ventas enviado a ${adminEmail}`);
            } catch (mailError) {
                console.error('Error al enviar correo de corte de ventas:', mailError);
                // No detener el proceso de corte por un error de correo
            }
        }


        // Reiniciar ventas.json a vacío
        await writeJsonFile(VENTAS_FILE, []);

        // Reiniciar números disponibles
        const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);

        // Incrementar el número de sorteo correlativo
        let configActualizada = await readJsonFile(CONFIG_FILE);
        configActualizada.numero_sorteo_correlativo = (configActualizada.numero_sorteo_correlativo || 0) + 1;
        // Opcional: Si quieres que el corte también avance la fecha del sorteo a mañana
        // configActualizada.fecha_sorteo = moment().tz('America/Caracas').add(1, 'day').format('YYYY-MM-DD');
        await writeJsonFile(CONFIG_FILE, configActualizada);


        res.json({ message: 'Corte de ventas realizado con éxito. Ventas y números reiniciados.' });
    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar corte de ventas.' });
    }
});


app.get('/api/ventas/exportar-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        if (ventas.length === 0) {
            return res.status(404).json({ message: 'No hay ventas para exportar.' });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Todas las Ventas');

        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 12 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 12 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Números Comprados', key: 'numeros', width: 25 },
            { header: 'Valor USD', key: 'valor_usd', width: 10 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Comprobante', key: 'comprobante_nombre', width: 30 }
        ];

        ventas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros: venta.numeros.join(', '),
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'Todas_Ventas_Sistema_Rifas.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error al exportar todas las ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas.' });
    }
});


// Rutas para horarios del Zulia
app.get('/api/horarios', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia: [] });
        res.json(horarios.horarios_zulia);
    } catch (error) {
        console.error('Error al leer horarios:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
});

app.post('/api/horarios', async (req, res) => {
    try {
        const { nuevoHorario } = req.body;
        if (!nuevoHorario) {
            return res.status(400).json({ message: 'El horario no puede estar vacío.' });
        }
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia: [] });
        if (!horarios.horarios_zulia.includes(nuevoHorario)) {
            horarios.horarios_zulia.push(nuevoHorario);
            await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
            return res.status(201).json({ message: 'Horario añadido con éxito.', horarios: horarios.horarios_zulia });
        }
        res.status(409).json({ message: 'El horario ya existe.' });
    } catch (error) {
        console.error('Error al añadir horario:', error);
        res.status(500).json({ message: 'Error interno del servidor al añadir horario.' });
    }
});

app.delete('/api/horarios/:horario', async (req, res) => {
    try {
        const horarioAEliminar = req.params.horario;
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE, { horarios_zulia: [] });
        const initialLength = horarios.horarios_zulia.length;
        horarios.horarios_zulia = horarios.horarios_zulia.filter(h => h !== horarioAEliminar);
        if (horarios.horarios_zulia.length < initialLength) {
            await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
            return res.json({ message: 'Horario eliminado con éxito.', horarios: horarios.horarios_zulia });
        }
        res.status(404).json({ message: 'Horario no encontrado.' });
    } catch (error) {
        console.error('Error al eliminar horario:', error);
        res.status(500).json({ message: 'Error interno del servidor al eliminar horario.' });
    }
});


// Rutas para resultados del Zulia
app.get('/api/resultados_zulia', async (req, res) => {
    try {
        const { fecha } = req.query;
        let resultados = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        if (fecha) {
            resultados = resultados.filter(r => r.fecha === fecha);
        }
        res.json(resultados);
    } catch (error) {
        console.error('Error al leer resultados del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados.' });
    }
});

app.post('/api/resultados_zulia', async (req, res) => {
    try {
        const { fecha, horario, resultado } = req.body;
        if (!fecha || !horario || !resultado) {
            return res.status(400).json({ message: 'Fecha, horario y resultado son obligatorios.' });
        }
        let resultados = await readJsonFile(RESULTADOS_ZULIA_FILE, []);

        // Validar si ya existe un resultado para la misma fecha y horario
        const existeResultado = resultados.some(r => r.fecha === fecha && r.horario === horario);
        if (existeResultado) {
            return res.status(409).json({ message: 'Ya existe un resultado para esta fecha y horario.' });
        }

        resultados.push({ fecha, horario, resultado });
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultados);

        // Actualizar la última fecha de resultados en la configuración
        let config = await readJsonFile(CONFIG_FILE);
        config.ultima_fecha_resultados_zulia = fecha;
        await writeJsonFile(CONFIG_FILE, config);

        res.status(201).json({ message: 'Resultado del Zulia guardado con éxito.' });
    } catch (error) {
        console.error('Error al guardar resultado del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al guardar resultado.' });
    }
});

app.delete('/api/resultados_zulia', async (req, res) => {
    try {
        const { fecha, horario } = req.body;
        if (!fecha || !horario) {
            return res.status(400).json({ message: 'Fecha y horario son obligatorios para eliminar.' });
        }
        let resultados = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        const initialLength = resultados.length;
        resultados = resultados.filter(r => !(r.fecha === fecha && r.horario === horario));
        if (resultados.length < initialLength) {
            await writeJsonFile(RESULTADOS_ZULIA_FILE, resultados);
            return res.json({ message: 'Resultado del Zulia eliminado con éxito.' });
        }
        res.status(404).json({ message: 'Resultado no encontrado.' });
    } catch (error) {
        console.error('Error al eliminar resultado del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al eliminar resultado.' });
    }
});


// Tarea programada para realizar el corte de ventas automáticamente
// Se ejecuta diariamente a la 01:00 AM (hora de Caracas)
cron.schedule('0 1 * * *', async () => {
    console.log('Ejecutando tarea programada de corte de ventas...');
    try {
        const now = moment().tz('America/Caracas');
        const yesterday = now.clone().subtract(1, 'days').format('YYYYMMDD');

        const ventas = await readJsonFile(VENTAS_FILE, []);
        if (ventas.length === 0) {
            console.log('No hay ventas para el corte automático.');
            return;
        }

        // Generar y guardar el Excel del corte automático
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Corte de Ventas ${yesterday}`);

        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 12 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 12 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Números Comprados', key: 'numeros', width: 25 },
            { header: 'Valor USD', key: 'valor_usd', width: 10 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Comprobante', key: 'comprobante_nombre', width: 30 }
        ];

        ventas.forEach(venta => {
            worksheet.addRow({
                ...venta,
                numeros: venta.numeros.join(', '),
            });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const filepath = path.join(COMPROBANTES_DIR, `Corte_Ventas_Automatico_${yesterday}.xlsx`);
        await fs.writeFile(filepath, buffer);
        console.log(`Corte de ventas automático guardado en: ${filepath}`);

        // Reiniciar ventas.json a vacío
        await writeJsonFile(VENTAS_FILE, []);
        console.log('Archivo de ventas reiniciado.');

        // Enviar por correo el reporte automático
        const config = await readJsonFile(CONFIG_FILE);
        const adminEmail = config.admin_email_for_reports;
        if (adminEmail && config.mail_config && config.mail_config.user && config.mail_config.pass) {
            const transporter = nodemailer.createTransport({
                host: config.mail_config.host,
                port: config.mail_config.port,
                secure: config.mail_config.secure,
                auth: {
                    user: config.mail_config.user,
                    pass: config.mail_config.pass,
                },
            });

            await transporter.sendMail({
                from: `"${config.mail_config.senderName}" <${config.mail_config.user}>`,
                to: adminEmail,
                subject: `Corte de Ventas Automático - ${now.format('YYYY-MM-DD')}`,
                html: `
                    <p>Adjunto encontrarás el reporte de corte de ventas automático del día ${now.format('YYYY-MM-DD')}.</p>
                    <p>Total de ventas en este corte: <strong>${ventas.length}</strong></p>
                    <p>Saludos cordiales,<br>Sistema de Rifas</p>
                `,
                attachments:
                    [{ filename: `Corte_Ventas_${yesterday}.xlsx`, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
            );
            console.log(`Correo de corte de ventas automático enviado a ${adminEmail}`);
        } else {
            console.warn('No se ha configurado un correo de administrador para reportes en la configuración.');
        }

        // Reiniciar números disponibles para el próximo sorteo
        const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
        console.log('Números disponibles reiniciados automáticamente para el próximo sorteo.');

        // Actualizar la fecha del próximo sorteo a mañana y el correlativo
        const nextDrawDate = now.clone().add(1, 'days').format('YYYY-MM-DD');
        config.fecha_sorteo = nextDrawDate;
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
        await writeJsonFile(CONFIG_FILE, config);
        console.log(`Fecha del próximo sorteo actualizada automáticamente a: ${nextDrawDate}`);


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas:', error);
    }
}, {
    timezone: "America/Caracas"
});


// Inicialización del servidor
ensureComprobantesDir().then(() => {
    app.listen(port, () => {
        console.log(`Servidor backend escuchando en http://localhost:${port}`);
    });
});