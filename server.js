const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Configura CORS
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app' // Tu panel de cliente
        // Si tu aplicación se ejecuta en localhost para desarrollo, puedes añadir:
        // 'http://localhost:8080', // O el puerto de desarrollo de tu cliente
        // 'http://127.0.0.1:5500' // Por ejemplo, si usas Live Server en VS Code
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json()); // Middleware para parsear JSON en el cuerpo de la solicitud

// NOTA IMPORTANTE:
// fileUpload AHORA se aplica solo a la ruta específica que lo necesita (/api/ventas)
// NO lo aplicamos globalmente con app.use(fileUpload(...));
// Esto evita la advertencia "Request is not eligible for file upload!" en otras rutas.

// Servir archivos estáticos (para los comprobantes subidos)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Rutas de Archivos de Configuración y Datos ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const NUMEROS_PATH = path.join(__dirname, 'numeros.json');
const VENTAS_PATH = path.join(__dirname, 'ventas.json');
const CORTES_PATH = path.join(__dirname, 'cortes.json'); // Archivo para guardar los cortes

// --- Funciones de Utilidad para I/O ---
async function leerArchivo(filePath, defaultValue = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // Archivo no encontrado
            console.warn(`Archivo ${filePath} no encontrado, creando con valor por defecto.`);
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
            return defaultValue;
        }
        throw error;
    }
}

async function escribirArchivo(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Email Transporter (Configura tus credenciales aquí) ---
const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com', // Ejemplo para Outlook/Office 365
    port: 587,
    secure: false, // true para 465, false para otros puertos como 587
    auth: {
        user: 'tucorreo@example.com', // TU CORREO
        pass: 'tucontraseña' // TU CONTRASEÑA
    },
    tls: {
        ciphers:'SSLv3'
    }
});

// Función para enviar correo de corte de ventas
async function enviarCorteAutomatico() {
    try {
        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        const cortesData = await leerArchivo(CORTES_PATH, { cortes: [] });

        const hoy = new Date();
        const fechaCorte = hoy.toISOString().split('T')[0]; // Formato YYYY-MM-DD

        // Filtrar ventas confirmadas que no han sido incluidas en un corte
        const ventasParaCorte = ventasData.ventas.filter(venta =>
            venta.estado === 'confirmado' &&
            !cortesData.cortes.some(corte => corte.ventasIncluidas.includes(venta.numeroTicket))
        );

        if (ventasParaCorte.length === 0) {
            console.log(`No hay ventas confirmadas pendientes de corte para hoy ${fechaCorte}.`);
            return;
        }

        const totalVentasBs = ventasParaCorte.reduce((sum, venta) => sum + venta.valorTotalBs, 0);
        const totalVentasUsd = ventasParaCorte.reduce((sum, venta) => sum + venta.valorTotalUsd, 0);

        const numerosTicketsCorte = ventasParaCorte.map(venta => venta.numeroTicket);

        const nuevoCorte = {
            id: `corte-${Date.now()}`,
            fechaCorte: fechaCorte,
            totalVentasBs: totalVentasBs.toFixed(2),
            totalVentasUsd: totalVentasUsd.toFixed(2),
            cantidadVentas: ventasParaCorte.length,
            ventasIncluidas: numerosTicketsCorte,
            detalleVentas: ventasParaCorte // Opcional: incluir el detalle completo de las ventas
        };

        cortesData.cortes.push(nuevoCorte);
        await escribirArchivo(CORTES_PATH, cortesData);
        console.log(`Corte de ventas del ${fechaCorte} generado. Total Bs: ${nuevoCorte.totalVentasBs}, Total USD: ${nuevoCorte.totalVentasUsd}`);

        const mailOptions = {
            from: 'tucorreo@example.com', // TU CORREO
            to: 'correo_destino@example.com', // CORREO DEL DESTINATARIO DEL CORTE
            subject: `Corte Automático de Ventas - ${fechaCorte}`,
            html: `
                <h2>Corte Automático de Ventas - ${fechaCorte}</h2>
                <p><strong>Fecha del Corte:</strong> ${nuevoCorte.fechaCorte}</p>
                <p><strong>Total Ventas (Bs):</strong> ${nuevoCorte.totalVentasBs}</p>
                <p><strong>Total Ventas (USD):</strong> ${nuevoCorte.totalVentasUsd}</p>
                <p><strong>Cantidad de Ventas:</strong> ${nuevoCorte.cantidadVentas}</p>
                <h3>Detalle de Ventas Incluidas:</h3>
                <ul>
                    ${ventasParaCorte.map(venta => `
                        <li>
                            Ticket: ${venta.numeroTicket},
                            Números: ${venta.numeros.join(', ')},
                            Comprador: ${venta.comprador},
                            Teléfono: ${venta.telefono},
                            Método de Pago: ${venta.metodoPago},
                            Referencia: ${venta.referenciaPago},
                            Valor: ${venta.valorTotalUsd} USD (${venta.valorTotalBs} Bs)
                        </li>
                    `).join('')}
                </ul>
                <p>Este es un correo automático, por favor no responder.</p>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('Correo de corte de ventas enviado exitosamente.');

    } catch (error) {
        console.error('Error al generar o enviar el corte automático de ventas:', error);
    }
}


// --- Rutas de la API (CLIENTE) ---

// Obtener números disponibles (para el panel del cliente)
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });

        if (config.pagina_bloqueada) {
            return res.status(200).json({
                paginaBloqueada: true,
                message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.',
                fechaSorteo: config.fecha_sorteo, // También enviamos la fecha aunque esté bloqueado
                numeroSorteoCorrelativo: config.numero_sorteo_correlativo
            });
        }

        if (!config.fecha_sorteo) {
            return res.status(200).json({
                numerosDisponibles: [],
                message: 'No hay una fecha de sorteo configurada por el administrador.',
                paginaBloqueada: false,
                fechaSorteo: null,
                numeroSorteoCorrelativo: null
            });
        }

        // Crear un Set de todos los números posibles (000-999)
        const todosLosNumeros = new Set();
        for (let i = 0; i < 1000; i++) {
            todosLosNumeros.add(String(i).padStart(3, '0'));
        }

        // Filtrar los números que ya están vendidos/pendientes para la fecha del sorteo actual
        const numerosVendidosOPendientes = new Set(
            numerosData.numeros
                .filter(n => n.fecha_sorteo === config.fecha_sorteo && (n.estado === 'confirmado' || n.estado === 'pendiente'))
                .map(n => n.numero)
        );

        const numerosDisponibles = Array.from(todosLosNumeros).filter(numero => !numerosVendidosOPendientes.has(numero));

        res.json({
            numerosDisponibles,
            precioTicket: config.precio_ticket,
            tasaDolar: config.tasa_dolar,
            fechaSorteo: config.fecha_sorteo,
            numeroSorteoCorrelativo: config.numero_sorteo_correlativo,
            paginaBloqueada: false
        });
    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números disponibles.', error: error.message });
    }
});


// Ruta para registrar una venta (POST)
// NOTA: Aquí es donde aplicamos fileUpload, ya que esta ruta puede recibir un archivo.
app.post('/api/ventas', fileUpload({ limits: { fileSize: 50 * 1024 * 1024 }, debug: true }), async (req, res) => {
    try {
        const {
            numeros,
            comprador,
            cedula, // Campo opcional
            telefono,
            email,    // Campo opcional
            metodoPago,
            referenciaPago, // Antes numeroComprobante
            valorTotalUsd,
            valorTotalBs,
            tasaAplicada,
            fechaSorteo // Viene del cliente
        } = req.body;

        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        const numerosRegistrados = await leerArchivo(NUMEROS_PATH, { numeros: [] });
        const ventasRegistradas = await leerArchivo(VENTAS_PATH, { ventas: [] });

        // --- VALIDACIONES DEL SERVIDOR ---
        if (config.pagina_bloqueada) {
            return res.status(403).json({ message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.' });
        }

        if (!config.fecha_sorteo) {
            return res.status(400).json({ message: 'No hay una fecha de sorteo configurada por el administrador.' });
        }

        if (fechaSorteo !== config.fecha_sorteo) {
            return res.status(400).json({ message: `La fecha del sorteo en la solicitud (${fechaSorteo}) no coincide con la fecha del sorteo actual configurada (${config.fecha_sorteo}). Por favor, recargue la página.` });
        }

        if (!Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({ message: 'Debe seleccionar al menos un número (formato: array de strings).' });
        }

        const numerosInvalidos = numeros.filter(num => typeof num !== 'string' || !/^\d{3}$/.test(num));
        if (numerosInvalidos.length > 0) {
            return res.status(400).json({ message: `Cada número seleccionado debe ser un string de 3 dígitos. Números inválidos: ${numerosInvalidos.join(', ')}` });
        }

        if (!comprador || typeof comprador !== 'string' || comprador.trim() === '') {
            return res.status(400).json({ message: 'El nombre del comprador es obligatorio y debe ser un texto.' });
        }
        if (!telefono || typeof telefono !== 'string' || telefono.trim() === '') {
            return res.status(400).json({ message: 'El teléfono es obligatorio y debe ser un texto.' });
        }
        if (!metodoPago || typeof metodoPago !== 'string' || metodoPago.trim() === '') {
            return res.status(400).json({ message: 'El método de pago es obligatorio y debe ser un texto.' });
        }
        if (!referenciaPago || typeof referenciaPago !== 'string' || referenciaPago.trim() === '') {
            return res.status(400).json({ message: 'La referencia de pago es obligatoria y debe ser un texto.' });
        }
        if (isNaN(parseFloat(valorTotalUsd)) || parseFloat(valorTotalUsd) <= 0 ||
            isNaN(parseFloat(valorTotalBs)) || parseFloat(valorTotalBs) <= 0 ||
            isNaN(parseFloat(tasaAplicada)) || parseFloat(tasaAplicada) <= 0) {
            return res.status(400).json({ message: 'Los valores de pago (USD, Bs, Tasa) deben ser numéricos y mayores que cero.' });
        }

        // Verificar si los números ya están tomados para la fecha del sorteo actual
        const numerosTomados = numerosRegistrados.numeros.filter(n =>
            numeros.includes(n.numero) &&
            n.fecha_sorteo === config.fecha_sorteo &&
            (n.estado === 'pendiente' || n.estado === 'confirmado')
        ).map(n => n.numero);

        if (numerosTomados.length > 0) {
            return res.status(409).json({
                message: `¡Ups! Los siguientes números ya están vendidos para el sorteo del ${config.fecha_sorteo}: ${numerosTomados.join(', ')}. Por favor, elige otros.`,
                numerosTomados: numerosTomados
            });
        }

        // Generar número de ticket único
        const numeroTicket = `T${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

        // Manejo de la subida de comprobante (opcional, si viene como archivo)
        let comprobanteUrl = null;
        if (req.files && req.files.comprobante) {
            const comprobante = req.files.comprobante;
            const uploadDir = path.join(__dirname, 'uploads');
            // Asegúrate de que el directorio 'uploads' exista
            await fs.mkdir(uploadDir, { recursive: true });
            const uploadPath = path.join(uploadDir, `${numeroTicket}-${comprobante.name}`);
            await comprobante.mv(uploadPath);
            comprobanteUrl = `/uploads/${numeroTicket}-${comprobante.name}`;
            console.log(`Comprobante subido: ${comprobanteUrl}`);
        }
        // Si no viene como archivo, comprobanteUrl se mantendrá null (o puedes asignarle un valor si quieres que la ref pago sea la URL)

        // Registrar la venta
        const nuevaVenta = {
            numeroTicket,
            numeros,
            comprador,
            cedula: cedula || '', // Si no se envió, guarda cadena vacía
            telefono,
            email: email || '',    // Si no se envió, guarda cadena vacía
            metodoPago,
            referenciaPago,
            valorTotalUsd: parseFloat(valorTotalUsd),
            valorTotalBs: parseFloat(valorTotalBs),
            tasaAplicada: parseFloat(tasaAplicada),
            fechaCompra: new Date().toISOString(),
            fechaSorteo: config.fecha_sorteo,
            estado: 'pendiente', // O 'confirmado' si no requiere revisión
            comprobanteUrl: comprobanteUrl, // URL del comprobante si se subió
            fechaConfirmacion: null,
            confirmadoPor: null
        };
        ventasRegistradas.ventas.push(nuevaVenta);
        await escribirArchivo(VENTAS_PATH, ventasRegistradas);

        // Marcar los números como vendidos/pendientes en el archivo numeros.json
        const numerosActualizados = numerosRegistrados.numeros.concat(
            numeros.map(num => ({
                numero: num,
                fecha_sorteo: config.fecha_sorteo,
                estado: 'pendiente', // O 'confirmado'
                numeroTicket: numeroTicket
            }))
        );
        numerosRegistrados.numeros = numerosActualizados;
        await escribirArchivo(NUMEROS_PATH, numerosRegistrados);

        res.status(201).json({ message: 'Venta registrada con éxito. Pendiente de confirmación.', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar la venta.', error: error.message });
    }
});


// --- Rutas de la API (ADMINISTRADOR) ---

// Obtener y Actualizar Configuración
app.get('/api/admin/configuracion', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.', error: error.message });
    }
});

app.post('/api/admin/configuracion', async (req, res) => {
    try {
        const { fecha_sorteo, precio_ticket, tasa_dolar, pagina_bloqueada } = req.body;
        let currentConfig = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });

        // Validación de campos
        if (typeof pagina_bloqueada !== 'boolean') {
            return res.status(400).json({ message: 'El campo pagina_bloqueada debe ser un booleano.' });
        }
        if (fecha_sorteo !== null && (typeof fecha_sorteo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_sorteo))) {
            return res.status(400).json({ message: 'El campo fecha_sorteo debe ser null o una cadena con formato AAAA-MM-DD.' });
        }
        if (isNaN(parseFloat(precio_ticket)) || parseFloat(precio_ticket) <= 0) {
            return res.status(400).json({ message: 'El precio del ticket debe ser un número positivo.' });
        }
        if (isNaN(parseFloat(tasa_dolar)) || parseFloat(tasa_dolar) <= 0) {
            return res.status(400).json({ message: 'La tasa del dólar debe ser un número positivo.' });
        }

        // Si se cambia la fecha del sorteo o se reinicia, actualizar el número correlativo y borrar números de sorteos anteriores
        if (fecha_sorteo !== currentConfig.fecha_sorteo) {
            console.log(`Fecha de sorteo cambiada de ${currentConfig.fecha_sorteo} a ${fecha_sorteo}.`);
            // Incrementar número correlativo si la fecha es nueva y no nula, o reiniciar si es nula
            if (fecha_sorteo) {
                currentConfig.numero_sorteo_correlativo = (currentConfig.numero_sorteo_correlativo || 0) + 1;
            } else {
                // Si la fecha se pone a null (no hay sorteo activo), el correlativo no se incrementa o se podría reiniciar a 0/1
                // Depende de la lógica que prefieras. Lo mantendremos en su valor actual.
            }

            // Opcional: limpiar números de sorteos COMPLETADOS anteriores
            if (fecha_sorteo) { // Solo limpiar si se está configurando un nuevo sorteo
                   const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });
                   // Mantener solo los números de la nueva fecha de sorteo
                   numerosData.numeros = numerosData.numeros.filter(n => n.fecha_sorteo === fecha_sorteo);
                   await escribirArchivo(NUMEROS_PATH, numerosData);
                   console.log(`Números no coincidentes con la nueva fecha de sorteo (${fecha_sorteo}) limpiados.`);
            }
        }


        currentConfig.fecha_sorteo = fecha_sorteo;
        currentConfig.precio_ticket = parseFloat(precio_ticket);
        currentConfig.tasa_dolar = parseFloat(tasa_dolar);
        currentConfig.pagina_bloqueada = pagina_bloqueada;

        await escribirArchivo(CONFIG_PATH, currentConfig);
        res.json({ message: 'Configuración actualizada con éxito.', config: currentConfig });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.', error: error.message });
    }
});


// Obtener todas las ventas
app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_PATH, { ventas: [] });
        res.json(ventas.ventas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.', error: error.message });
    }
});

// Actualizar estado de una venta (confirmar/rechazar)
app.put('/api/admin/ventas/:numeroTicket', async (req, res) => {
    try {
        const { numeroTicket } = req.params;
        const { estado, confirmadoPor } = req.body; // 'confirmado', 'rechazado'

        if (!['confirmado', 'rechazado'].includes(estado)) {
            return res.status(400).json({ message: 'El estado debe ser "confirmado" o "rechazado".' });
        }
        if (estado === 'confirmado' && (!confirmadoPor || typeof confirmadoPor !== 'string' || confirmadoPor.trim() === '')) {
            return res.status(400).json({ message: 'El nombre de quien confirma es obligatorio para confirmar la venta.' });
        }

        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        const ventaIndex = ventasData.ventas.findIndex(v => v.numeroTicket === numeroTicket);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        const venta = ventasData.ventas[ventaIndex];
        const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });

        if (estado === 'confirmado' && venta.estado !== 'confirmado') {
            // Confirmar venta
            venta.estado = 'confirmado';
            venta.fechaConfirmacion = new Date().toISOString();
            venta.confirmadoPor = confirmadoPor;

            // Actualizar estado de los números asociados
            venta.numeros.forEach(num => {
                const numeroIndex = numerosData.numeros.findIndex(n => n.numero === num && n.fecha_sorteo === venta.fechaSorteo && n.numeroTicket === numeroTicket);
                if (numeroIndex !== -1) {
                    numerosData.numeros[numeroIndex].estado = 'confirmado';
                }
            });
            await escribirArchivo(NUMEROS_PATH, numerosData);

        } else if (estado === 'rechazado' && venta.estado !== 'rechazado') {
            // Rechazar venta
            venta.estado = 'rechazado';
            venta.fechaConfirmacion = null; // Opcional, si quieres borrarlo
            venta.confirmadoPor = confirmadoPor; // Quien lo rechaza

            // Liberar los números asociados (quitar de la lista de números vendidos/pendientes)
            numerosData.numeros = numerosData.numeros.filter(n => !(n.numeroTicket === numeroTicket && n.fecha_sorteo === venta.fechaSorteo));
            await escribirArchivo(NUMEROS_PATH, numerosData);
        } else {
              // Si el estado es el mismo que se intenta poner
              return res.status(400).json({ message: `La venta ya tiene el estado '${estado}'.` });
        }

        await escribirArchivo(VENTAS_PATH, ventasData);
        res.json({ message: `Venta ${numeroTicket} actualizada a estado: ${estado}.`, venta: venta });

    } catch (error) {
        console.error('Error al actualizar estado de venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar estado de venta.', error: error.message });
    }
});

// Obtener números vendidos/disponibles para la fecha actual (para el panel de administración)
app.get('/api/admin/numeros', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });

        const todosLosNumeros = new Set();
        for (let i = 0; i < 1000; i++) {
            todosLosNumeros.add(String(i).padStart(3, '0'));
        }

        const numerosPorFecha = numerosData.numeros.filter(n => n.fecha_sorteo === config.fecha_sorteo);

        // Convertir a un mapa para fácil acceso por número
        const mapaNumerosVendidos = new Map();
        numerosPorFecha.forEach(n => {
            mapaNumerosVendidos.set(n.numero, n.estado);
        });

        const estadoNumeros = Array.from(todosLosNumeros).map(numero => ({
            numero: numero,
            estado: mapaNumerosVendidos.has(numero) ? mapaNumerosVendidos.get(numero) : 'disponible'
        }));

        res.json({
            fechaSorteo: config.fecha_sorteo,
            estadoNumeros: estadoNumeros
        });
    } catch (error) {
        console.error('Error al obtener estado de números para admin:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener estado de números.', error: error.message });
    }
});


// Reportes de Ventas (Ejemplo: por fecha, o por método de pago)
app.get('/api/admin/reportes/ventas', async (req, res) => {
    const { fecha_sorteo, estado } = req.query; // Filtros opcionales
    try {
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        let ventasFiltradas = ventasData.ventas;

        if (fecha_sorteo) {
            ventasFiltradas = ventasFiltradas.filter(venta => venta.fechaSorteo === fecha_sorteo);
        }
        if (estado) {
            ventasFiltradas = ventasFiltradas.filter(venta => venta.estado === estado);
        }

        res.json(ventasFiltradas);
    } catch (error) {
        console.error('Error al generar reporte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar reporte de ventas.', error: error.message });
    }
});

// Generar Excel de Ventas
app.get('/api/admin/reportes/excel-ventas', async (req, res) => {
    const { fecha_sorteo, estado } = req.query;
    try {
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        let ventasFiltradas = ventasData.ventas;

        if (fecha_sorteo) {
            ventasFiltradas = ventasFiltradas.filter(venta => venta.fechaSorteo === fecha_sorteo);
        }
        if (estado) {
            ventasFiltradas = ventasFiltradas.filter(venta => venta.estado === estado);
        }

        const dataForExcel = ventasFiltradas.map(venta => ({
            'Número Ticket': venta.numeroTicket,
            'Números Comprados': venta.numeros.join(', '),
            'Comprador': venta.comprador,
            'Cédula': venta.cedula,
            'Teléfono': venta.telefono,
            'Email': venta.email,
            'Método de Pago': venta.metodoPago,
            'Referencia Pago': venta.referenciaPago,
            'Valor USD': venta.valorTotalUsd,
            'Valor Bs': venta.valorTotalBs,
            'Tasa Aplicada': venta.tasaAplicada,
            'Fecha Compra': new Date(venta.fechaCompra).toLocaleString(),
            'Fecha Sorteo': venta.fechaSorteo,
            'Estado': venta.estado,
            'Confirmado Por': venta.confirmadoPor || 'N/A',
            'Fecha Confirmación': venta.fechaConfirmacion ? new Date(venta.fechaConfirmacion).toLocaleString() : 'N/A'
        }));

        const ws = XLSX.utils.json_to_sheet(dataForExcel);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Ventas');

        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="reporte_ventas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(excelBuffer);

    } catch (error) {
        console.error('Error al generar el Excel de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al generar el Excel de ventas.', error: error.message });
    }
});


// Obtener todos los cortes de ventas
app.get('/api/admin/cortes', async (req, res) => {
    try {
        const cortesData = await leerArchivo(CORTES_PATH, { cortes: [] });
        res.json(cortesData.cortes);
    } catch (error) {
        console.error('Error al obtener los cortes de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener los cortes de ventas.', error: error.message });
    }
});


// Tarea programada: Envío de corte automático de ventas cada día a una hora específica
// Por ejemplo, para que se ejecute todos los días a las 00:00 (medianoche)
// Es crucial que esta hora sea después del último sorteo del día.
// Puedes configurar esto en tu archivo de configuración si lo necesitas dinámico.
cron.schedule('0 0 * * *', async () => { // Se ejecuta a las 00:00 todos los días
    console.log('Ejecutando tarea programada: Envío de corte automático de ventas.');
    await enviarCorteAutomatico();
}, {
    timezone: "America/Caracas" // Asegúrate de que esta zona horaria sea la correcta
});

// Puedes añadir más tareas cron aquí si necesitas otras automatizaciones.
// Por ejemplo, una para actualizar resultados de loterías externas.

// --- Manejo de rutas no encontradas ---
app.use((req, res, next) => {
    res.status(404).json({ message: 'Ruta no encontrada.' });
});

// --- Manejador de errores global ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Algo salió mal en el servidor!', error: err.message });
});


// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    console.log(`Acceso al panel de administración en: https://paneladmin01.netlify.app`);
    console.log(`Acceso al panel de cliente en: https://tuoportunidadeshoy.netlify.app`);
});