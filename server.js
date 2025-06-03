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
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// Directorios para guardar datos
const DATA_DIR = path.join(__dirname, 'data');
const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');

// Rutas de archivos de datos
const CONFIG_FILE = path.join(DATA_DIR, 'configuracion.json');
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horariosZulia.json');

// Declarar transporter aquí, pero inicializarlo después de cargar la configuración
let transporter;

// Función para asegurar que los directorios existan
async function ensureDataAndComprobantesDirs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true }); // Para archivos temporales como Excel
}

// Funciones de lectura/escritura de archivos JSON
async function readJsonFile(filePath, defaultValue = []) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // Archivo no encontrado
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Números iniciales para el reinicio
const initialNumbers = Array.from({ length: 1000 }, (_, i) => ({
    numero: String(i).padStart(3, '0'),
    comprado: false,
    fecha_compra: null,
    comprador: null,
    telefono: null,
    metodo_pago: null,
    referencia_pago: null
}));

// Carga inicial de datos
async function loadInitialData() {
    global.config = await readJsonFile(CONFIG_FILE, {
        precio_ticket: 1.00,
        tasa_dolar: 36.50,
        fecha_sorteo: moment().add(1, 'day').format('YYYY-MM-DD'),
        ultimo_numero_ticket: 0,
        ultimo_numero_sorteo_correlativo: 1,
        pagina_bloqueada: false,
        admin_whatsapp_numbers: ['584143630488'],
        horarios_zulia: [],
        mail_config: {
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            user: "tu_email@gmail.com",
            pass: "tu_contraseña_de_aplicacion"
        },
        admin_email_for_reports: "tu_email_admin@gmail.com"
    });
    global.numeros = await readJsonFile(NUMEROS_FILE, initialNumbers);
    global.ventas = await readJsonFile(VENTAS_FILE, []);
    global.horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, []);

    // Inicializar transporter después de que global.config esté disponible
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: global.config.mail_config.user,
            pass: global.config.mail_config.pass
        }
    });
}

// Servir archivos estáticos (comprobantes)
app.use('/comprobantes', express.static(COMPROBANTES_DIR));

// Configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la configuración', error: error.message });
    }
});

app.put('/api/configuracion', async (req, res) => {
    try {
        let config = await readJsonFile(CONFIG_FILE);
        const updatedConfig = { ...config, ...req.body };
        await writeJsonFile(CONFIG_FILE, updatedConfig);
        global.config = updatedConfig; // Actualizar la variable global en memoria
        res.status(200).json({ message: 'Configuración actualizada', config: updatedConfig });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar la configuración', error: error.message });
    }
});

// Números
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE);
        res.json(numeros);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener los números', error: error.message });
    }
});

// Comprar números
app.post('/api/numeros/comprar', async (req, res) => {
    try {
        const { numerosSeleccionados, comprador, telefono, metodoPago, referenciaPago, valorUsd, valorBs } = req.body;
        let numeros = await readJsonFile(NUMEROS_FILE);
        let ventas = await readJsonFile(VENTAS_FILE);
        let config = await readJsonFile(CONFIG_FILE);

        const now = moment().tz("America/Caracas");
        const fechaCompra = now.format('YYYY-MM-DD HH:mm:ss');
        const fechaSorteo = config.fecha_sorteo;
        const numeroSorteoCorrelativo = config.ultimo_numero_sorteo_correlativo;

        // Verificar si algún número ya fue comprado
        const numerosYaComprados = numerosSeleccionados.filter(n =>
            numeros.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (numerosYaComprados.length > 0) {
            return res.status(400).json({ message: `Los números ${numerosYaComprados.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        // Incrementar el número de ticket correlativo globalmente
        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        await writeJsonFile(CONFIG_FILE, config);

        const numeroTicket = config.ultimo_numero_ticket;

        // Marcar números como comprados
        numerosSeleccionados.forEach(selectedNum => {
            const index = numeros.findIndex(n => n.numero === selectedNum);
            if (index !== -1) {
                numeros[index].comprado = true;
                numeros[index].fecha_compra = fechaCompra;
                numeros[index].comprador = comprador;
                numeros[index].telefono = telefono;
                numeros[index].metodo_pago = metodoPago;
                numeros[index].referencia_pago = referenciaPago;
            }
        });

        // Crear registro de venta
        const nuevaVenta = {
            id: ventas.length > 0 ? Math.max(...ventas.map(v => v.id)) + 1 : 1,
            numero_ticket: numeroTicket,
            numeros: numerosSeleccionados,
            comprador: comprador,
            telefono: telefono,
            metodo_pago: metodoPago,
            referencia_pago: referenciaPago,
            valor_usd: valorUsd,
            valor_bs: valorBs,
            fecha_compra: fechaCompra,
            fecha_sorteo: fechaSorteo,
            numero_sorteo: numeroSorteoCorrelativo,
            url_comprobante: null // Se llenará si se sube un comprobante
        };
        ventas.push(nuevaVenta);

        await writeJsonFile(NUMEROS_FILE, numeros);
        await writeJsonFile(VENTAS_FILE, ventas);

        res.status(201).json({ message: 'Compra realizada con éxito', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al comprar números:', error);
        res.status(500).json({ message: 'Error interno al procesar la compra', error: error.message });
    }
});

// Obtener todas las ventas (para el panel de administración)
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        res.json(ventas);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener las ventas', error: error.message });
    }
});


// RUTA EXISTENTE: Realizar corte de ventas, enviar reporte por email y REINICIAR el sistema (USADA POR CRON JOB)
app.post('/api/ventas/corte', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        let config = await readJsonFile(CONFIG_FILE); // Cargar configuración para reiniciar números

        // Generar el nombre del archivo Excel
        const now = moment().tz("America/Caracas");
        const dateString = now.format('YYYYMMMM_HHmmss');
        const excelFileName = `Reporte_Ventas_${dateString}.xlsx`;
        const excelFilePath = path.join(__dirname, 'temp', excelFileName);

        // Mapear los datos para el archivo Excel
        const dataToExport = ventas.map(venta => ({
            'Fecha/Hora Compra': venta.fecha_compra ? moment(venta.fecha_compra).format('DD/MM/YYYY HH:mm:ss') : 'N/A',
            'Fecha Sorteo': venta.fecha_sorteo ? moment(venta.fecha_sorteo).format('DD/MM/YYYY') : 'N/A',
            'Nro. Sorteo': venta.numero_sorteo || 'N/A',
            'Nro. Ticket': venta.numero_ticket || 'N/A',
            'Comprador': venta.comprador || 'N/A',
            'Teléfono': venta.telefono || 'N/A',
            'Números': (venta.numeros && venta.numeros.length > 0) ? venta.numeros.join(', ') : 'N/A',
            'Valor USD': (venta.valor_usd !== undefined) ? venta.valor_usd.toFixed(2) : 'N/A',
            'Valor Bs': (venta.valor_bs !== undefined) ? venta.valor_bs.toFixed(2) : 'N/A',
            'Método de Pago': venta.metodo_pago || 'N/A',
            'Referencia Pago': venta.referencia_pago || 'N/A',
            'URL Comprobante': venta.url_comprobante || 'N/A'
        }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        if (dataToExport.length > 0) {
            // Añadir encabezados
            worksheet.columns = Object.keys(dataToExport[0]).map(key => ({
                header: key,
                key: key,
                width: key === 'Fecha/Hora Compra' || key === 'Teléfono' ? 20 : 15
            }));
            // Añadir datos
            worksheet.addRows(dataToExport);
            // Estilos para encabezados (opcional)
            worksheet.getRow(1).eachCell((cell) => {
                cell.font = { bold: true };
                cell.alignment = { horizontal: 'center' };
            });
        } else {
            console.log('No hay ventas registradas para generar el reporte Excel (corte con reinicio). Se enviará un Excel con solo encabezados.');
            worksheet.columns = [
                { header: 'Fecha/Hora Compra', key: 'Fecha/Hora Compra', width: 20 },
                { header: 'Fecha Sorteo', key: 'Fecha Sorteo', width: 15 },
                { header: 'Nro. Sorteo', key: 'Nro. Sorteo', width: 15 },
                { header: 'Nro. Ticket', key: 'Nro. Ticket', width: 15 },
                { header: 'Comprador', key: 'Comprador', width: 15 },
                { header: 'Teléfono', key: 'Teléfono', width: 20 },
                { header: 'Números', key: 'Números', width: 15 },
                { header: 'Valor USD', key: 'Valor USD', width: 15 },
                { header: 'Valor Bs', key: 'Valor Bs', width: 15 },
                { header: 'Método de Pago', key: 'Método de Pago', width: 15 },
                { header: 'Referencia Pago', key: 'Referencia Pago', width: 15 },
                { header: 'URL Comprobante', key: 'URL Comprobante', width: 15 }
            ];
        }

        // Crear el buffer del archivo Excel
        const excelBuffer = await workbook.xlsx.writeBuffer();

        // Enviar el correo electrónico
        const mailOptions = {
            from: global.config.mail_config.user,
            to: global.config.admin_email_for_reports,
            subject: `Corte de Ventas y Reinicio - ${now.format('DD/MM/YYYY HH:mm')}`,
            html: `
                <p>Adjunto encontrarás el reporte de ventas correspondiente al corte y reinicio realizado el ${now.format('DD/MM/YYYY')} a las ${now.format('HH:mm:ss')}.</p>
                <p>Las ventas y los números disponibles han sido reiniciados.</p>
                ${dataToExport.length > 0 ? `<p>Total de ventas en este corte: ${ventas.length}</p>` : `<p>No se registraron ventas en este corte.</p>`}
                <p>Gracias.</p>
            `,
            attachments: [{
                filename: excelFileName,
                content: excelBuffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }]
        };

        await transporter.sendMail(mailOptions);

        console.log('Reporte de ventas enviado por correo electrónico y sistema reiniciado.');

        // Reiniciar las ventas y los números disponibles
        await writeJsonFile(VENTAS_FILE, []); // Borra las ventas
        await writeJsonFile(NUMEROS_FILE, initialNumbers); // Reinicia los números a su estado inicial

        // Actualizar el número de sorteo correlativo y reiniciar el ticket para el nuevo ciclo
        config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
        config.ultimo_numero_ticket = 0;
        await writeJsonFile(CONFIG_FILE, config);

        res.status(200).json({ message: 'Corte de ventas realizado, reporte enviado y sistema reiniciado con éxito.' });

    } catch (error) {
        console.error('Error en el corte de ventas y reinicio:', error);
        res.status(500).json({ message: 'Error interno al realizar el corte de ventas y reinicio.' });
    }
});

// NUEVA RUTA: Realizar corte de ventas y enviar reporte por email (SIN REINICIAR VENTAS)
app.post('/api/ventas/corte-manual-solo-email', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        const config = await readJsonFile(CONFIG_FILE);

        // Generar el nombre del archivo Excel
        const now = moment().tz("America/Caracas");
        const dateString = now.format('YYYYMMDD_HHmmss');
        const excelFileName = `Reporte_Ventas_${dateString}.xlsx`;

        // Mapear los datos para el archivo Excel
        const dataToExport = ventas.map(venta => ({
            'Fecha/Hora Compra': venta.fecha_compra ? moment(venta.fecha_compra).format('DD/MM/YYYY HH:mm:ss') : 'N/A',
            'Fecha Sorteo': venta.fecha_sorteo ? moment(venta.fecha_sorteo).format('DD/MM/YYYY') : 'N/A',
            'Nro. Sorteo': venta.numero_sorteo || 'N/A',
            'Nro. Ticket': venta.numero_ticket || 'N/A',
            'Comprador': venta.comprador || 'N/A',
            'Teléfono': venta.telefono || 'N/A',
            'Números': (venta.numeros && venta.numeros.length > 0) ? venta.numeros.join(', ') : 'N/A',
            'Valor USD': (venta.valor_usd !== undefined) ? venta.valor_usd.toFixed(2) : 'N/A',
            'Valor Bs': (venta.valor_bs !== undefined) ? venta.valor_bs.toFixed(2) : 'N/A',
            'Método de Pago': venta.metodo_pago || 'N/A',
            'Referencia Pago': venta.referencia_pago || 'N/A',
            'URL Comprobante': venta.url_comprobante || 'N/A'
        }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        if (dataToExport.length > 0) {
            // Añadir encabezados
            worksheet.columns = Object.keys(dataToExport[0]).map(key => ({
                header: key,
                key: key,
                width: key === 'Fecha/Hora Compra' || key === 'Teléfono' ? 20 : 15
            }));

            // Añadir datos
            worksheet.addRows(dataToExport);

            // Estilos para encabezados (opcional)
            worksheet.getRow(1).eachCell((cell) => {
                cell.font = { bold: true };
                cell.alignment = { horizontal: 'center' };
            });
        } else {
            console.log('No hay ventas registradas para generar el reporte Excel (corte manual). Se enviará un Excel con solo encabezados.');
            worksheet.columns = [
                { header: 'Fecha/Hora Compra', key: 'Fecha/Hora Compra', width: 20 },
                { header: 'Fecha Sorteo', key: 'Fecha Sorteo', width: 15 },
                { header: 'Nro. Sorteo', key: 'Nro. Sorteo', width: 15 },
                { header: 'Nro. Ticket', key: 'Nro. Ticket', width: 15 },
                { header: 'Comprador', key: 'Comprador', width: 15 },
                { header: 'Teléfono', key: 'Teléfono', width: 20 },
                { header: 'Números', key: 'Números', width: 15 },
                { header: 'Valor USD', key: 'Valor USD', width: 15 },
                { header: 'Valor Bs', key: 'Valor Bs', width: 15 },
                { header: 'Método de Pago', key: 'Método de Pago', width: 15 },
                { header: 'Referencia Pago', key: 'Referencia Pago', width: 15 },
                { header: 'URL Comprobante', key: 'URL Comprobante', width: 15 }
            ];
        }

        // Crear el buffer del archivo Excel
        const excelBuffer = await workbook.xlsx.writeBuffer();

        // Enviar el correo electrónico
        const mailOptions = {
            from: global.config.mail_config.user,
            to: global.config.admin_email_for_reports,
            subject: `Corte de Ventas Manual - ${now.format('DD/MM/YYYY HH:mm')}`,
            html: `
                <p>Adjunto encontrarás el reporte de ventas correspondiente al corte manual realizado el ${now.format('DD/MM/YYYY')} a las ${now.format('HH:mm:ss')}.</p>
                ${dataToExport.length > 0 ? `<p>Total de ventas registradas en este corte: ${ventas.length}</p>` : `<p>No se registraron ventas en este corte.</p>`}
                <p>Este corte fue solicitado manualmente y las ventas NO han sido reiniciadas.</p>
                <p>Gracias.</p>
            `,
            attachments: [{
                filename: excelFileName,
                content: excelBuffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }]
        };

        await transporter.sendMail(mailOptions);

        console.log('Reporte de ventas manual enviado por correo electrónico (sin reinicio).');

        // ***** IMPORTANTE: NO REINICIAR VENTAS NI NÚMEROS AQUÍ *****
        // Las ventas se mantienen intactas en la base de datos (VENTAS_FILE).
        // Los números disponibles en NUMEROS_FILE no se tocan.
        // No se actualiza config.ultimo_numero_sorteo_correlativo ni ultimo_numero_ticket aquí.

        res.status(200).json({ message: 'Corte de ventas realizado y reporte enviado por correo. Las ventas NO han sido reiniciadas.' });

    } catch (error) {
        console.error('Error en el corte de ventas (solo email):', error);
        res.status(500).json({ message: 'Error interno al realizar el corte de ventas.' });
    }
});

// Rutas para Horarios del Zulia
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener horarios del Zulia', error: error.message });
    }
});

app.post('/api/horarios-zulia', async (req, res) => {
    try {
        const { horario } = req.body;
        if (!horario || !/^\d{2}:\d{2}$/.test(horario)) {
            return res.status(400).json({ message: 'Formato de horario inválido. Use HH:MM.' });
        }
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE, []);
        if (horarios.includes(horario)) {
            return res.status(409).json({ message: 'El horario ya existe.' });
        }
        horarios.push(horario);
        horarios.sort(); // Opcional: ordenar los horarios
        await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
        global.horariosZulia = horarios; // Actualizar globalmente
        res.status(201).json({ message: 'Horario agregado con éxito', horarios });
    } catch (error) {
        res.status(500).json({ message: 'Error al agregar horario', error: error.message });
    }
});

app.delete('/api/horarios-zulia', async (req, res) => {
    try {
        const { horario } = req.body;
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        const initialLength = horarios.length;
        horarios = horarios.filter(h => h !== horario);
        if (horarios.length === initialLength) {
            return res.status(404).json({ message: 'Horario no encontrado.' });
        }
        await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
        global.horariosZulia = horarios; // Actualizar globalmente
        res.status(200).json({ message: 'Horario eliminado con éxito', horarios });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar horario', error: error.message });
    }
});

// Tarea programada (CRON JOB): Esta sigue siendo la que reinicia
cron.schedule(process.env.CRON_SCHEDULE || '0 0 * * *', async () => { // Todos los días a medianoche (hora de Caracas)
    try {
        console.log('Iniciando tarea programada de corte de ventas y reinicio...');
        const ventas = await readJsonFile(VENTAS_FILE);
        let config = await readJsonFile(CONFIG_FILE);

        // Solo procede si hay ventas o si la fecha de sorteo actual es pasada
        const now = moment().tz("America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');
        const currentDrawDate = config.fecha_sorteo;

        // Comprueba si la fecha del sorteo actual es anterior o igual a hoy
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted) || ventas.length > 0) {
            console.log('Realizando corte de ventas y reinicio por tarea programada.');

            const dateString = now.format('YYYYMMDD_HHmmss');
            const excelFileName = `Reporte_Ventas_Automatica_${dateString}.xlsx`;

            const dataToExport = ventas.map(venta => ({
                'Fecha/Hora Compra': venta.fecha_compra ? moment(venta.fecha_compra).format('DD/MM/YYYY HH:mm:ss') : 'N/A',
                'Fecha Sorteo': venta.fecha_sorteo ? moment(venta.fecha_sorteo).format('DD/MM/YYYY') : 'N/A',
                'Nro. Sorteo': venta.numero_sorteo || 'N/A',
                'Nro. Ticket': venta.numero_ticket || 'N/A',
                'Comprador': venta.comprador || 'N/A',
                'Teléfono': venta.telefono || 'N/A',
                'Números': (venta.numeros && venta.numeros.length > 0) ? venta.numeros.join(', ') : 'N/A',
                'Valor USD': (venta.valor_usd !== undefined) ? venta.valor_usd.toFixed(2) : 'N/A',
                'Valor Bs': (venta.valor_bs !== undefined) ? venta.valor_bs.toFixed(2) : 'N/A',
                'Método de Pago': venta.metodo_pago || 'N/A',
                'Referencia Pago': venta.referencia_pago || 'N/A',
                'URL Comprobante': venta.url_comprobante || 'N/A'
            }));

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Ventas');

            if (dataToExport.length > 0) {
                worksheet.columns = Object.keys(dataToExport[0]).map(key => ({
                    header: key,
                    key: key,
                    width: key === 'Fecha/Hora Compra' || key === 'Teléfono' ? 20 : 15
                }));
                worksheet.addRows(dataToExport);
                worksheet.getRow(1).eachCell((cell) => {
                    cell.font = { bold: true };
                    cell.alignment = { horizontal: 'center' };
                });
            } else {
                console.log('No hay ventas registradas para generar el reporte Excel (cron job). Se enviará un Excel con solo encabezados.');
                worksheet.columns = [
                    { header: 'Fecha/Hora Compra', key: 'Fecha/Hora Compra', width: 20 },
                    { header: 'Fecha Sorteo', key: 'Fecha Sorteo', width: 15 },
                    { header: 'Nro. Sorteo', key: 'Nro. Sorteo', width: 15 },
                    { header: 'Nro. Ticket', key: 'Nro. Ticket', width: 15 },
                    { header: 'Comprador', key: 'Comprador', width: 15 },
                    { header: 'Teléfono', key: 'Teléfono', width: 20 },
                    { header: 'Números', key: 'Números', width: 15 },
                    { header: 'Valor USD', key: 'Valor USD', width: 15 },
                    { header: 'Valor Bs', key: 'Valor Bs', width: 15 },
                    { header: 'Método de Pago', key: 'Método de Pago', width: 15 },
                    { header: 'Referencia Pago', key: 'Referencia Pago', width: 15 },
                    { header: 'URL Comprobante', key: 'URL Comprobante', width: 15 }
                ];
            }

            const excelBuffer = await workbook.xlsx.writeBuffer();

            const mailOptions = {
                from: global.config.mail_config.user,
                to: global.config.admin_email_for_reports,
                subject: `Reporte Automático de Ventas y Reinicio - ${now.format('DD/MM/YYYY HH:mm')}`,
                html: `
                    <p>Adjunto encontrarás el reporte de ventas del día, generado automáticamente.</p>
                    <p>El sistema de ventas y números disponibles ha sido reiniciado para el próximo sorteo.</p>
                    ${dataToExport.length > 0 ? `<p>Total de ventas registradas en este corte: ${ventas.length}</p>` : `<p>No se registraron ventas en este corte.</p>`}
                    <p>Gracias.</p>
                `,
                attachments: [{
                    filename: excelFileName,
                    content: excelBuffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }]
            };

            await transporter.sendMail(mailOptions);
            console.log('Reporte de ventas automático enviado por correo electrónico.');

            // Reiniciar ventas y números
            await writeJsonFile(VENTAS_FILE, []); // Borra las ventas
            await writeJsonFile(NUMEROS_FILE, initialNumbers); // Reinicia los números

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
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app/`);
            console.log(`Plataforma de rifas disponible en: https://tuoportunidadeshoy.netlify.app/`);
        });
    });
});