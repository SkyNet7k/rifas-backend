// adminUtils.js
const admin = require('firebase-admin');
const moment = require('moment-timezone');

/**
 * Lee un documento específico de Firestore.
 * @param {object} db - La instancia de Firestore.
 * @param {string} collectionName - El nombre de la colección.
 * @param {string} docId - El ID del documento.
 * @returns {Promise<object|null>} El objeto del documento si existe, o null.
 */
async function readFirestoreDoc(db, collectionName, docId) {
    try {
        const docRef = db.collection(collectionName).doc(docId);
        const doc = await docRef.get();
        if (doc.exists) {
            return doc.data();
        } else {
            console.log(`Documento ${docId} no encontrado en colección ${collectionName}.`);
            return null;
        }
    } catch (error) {
        console.error(`Error leyendo documento ${docId} en colección ${collectionName}:`, error);
        throw error; // Re-lanzar el error para que sea manejado por el llamador
    }
}

/**
 * Escribe (establece o actualiza) un documento en Firestore.
 * Si el documento no existe, lo crea. Si existe, lo sobrescribe o fusiona.
 * @param {object} db - La instancia de Firestore.
 * @param {string} collectionName - El nombre de la colección.
 * @param {string} docId - El ID del documento.
 * @param {object} data - Los datos a escribir.
 * @param {boolean} merge - Si es true, fusiona los datos con el documento existente. Si es false, sobrescribe.
 * @returns {Promise<boolean>} True si la operación fue exitosa.
 */
async function writeFirestoreDoc(db, collectionName, docId, data, merge = true) {
    try {
        const docRef = db.collection(collectionName).doc(docId);
        await docRef.set(data, { merge });
        return true;
    } catch (error) {
        console.error(`Error escribiendo documento ${docId} en colección ${collectionName}:`, error);
        throw error;
    }
}

/**
 * Función para limpiar todos los datos de la base de datos de Firestore
 * y reiniciar la configuración de la aplicación.
 * @param {object} db - La instancia de Firestore.
 * @param {object} configuracionGlobal - La configuración global actual del servidor.
 * @param {string} CARACAS_TIMEZONE - La zona horaria de Caracas.
 * @param {function} loadInitialDataFn - Función para recargar los datos iniciales del servidor.
 * @param {object} res - Objeto de respuesta de Express.
 */
async function handleLimpiarDatos(db, configuracionGlobal, CARACAS_TIMEZONE, loadInitialDataFn, res) {
    console.log('Iniciando proceso de limpieza de datos en Firestore...');
    try {
        // Colecciones a limpiar (ajusta según tus necesidades)
        const collectionsToClear = ['raffle_numbers', 'sales', 'lottery_times', 'draw_results', 'prizes', 'winners'];

        for (const collectionName of collectionsToClear) {
            console.log(`Limpiando colección: ${collectionName}`);
            const snapshot = await db.collection(collectionName).get();
            const batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`Colección ${collectionName} limpiada.`);
        }

        // Reiniciar la configuración principal de la aplicación
        const defaultAppConfig = {
            pagina_bloqueada: false,
            block_reason_message: "",
            fecha_sorteo: moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0,
            tasa_dolar: 36.50, // Valor por defecto
            // Mantener la configuración de correo
            admin_email_for_reports: configuracionGlobal.admin_email_for_reports || [], // Mantener correos de reporte
            raffleNumbersInitialized: false, // Resetear para que se reinicialicen los números de rifa
            last_sales_notification_count: 0,
            sales_notification_threshold: 20,
            block_reason_message: ""
        };
        await writeFirestoreDoc(db, 'app_config', 'main_config', defaultAppConfig, false); // Sobrescribir completamente

        // Reiniciar horarios y premios a valores por defecto (vacíos o iniciales)
        await writeFirestoreDoc(db, 'lottery_times', 'zulia_chance', { zulia: [], chance: [] }, false);
        await writeFirestoreDoc(db, 'prizes', 'daily_prizes', {}, false);

        // Recargar todos los datos iniciales, lo que también reinicializará 'raffle_numbers'
        await loadInitialDataFn(); // Llama a la función de carga inicial del server.js

        res.status(200).json({ message: 'Todos los datos de la base de datos han sido limpiados y la configuración reiniciada a valores por defecto. Los números de la rifa han sido reinicializados.' });

    } catch (error) {
        console.error('Error durante la limpieza de datos en Firestore:', error);
        res.status(500).json({ message: 'Error interno del servidor al limpiar los datos.', error: error.message });
    }
}

module.exports = {
    readFirestoreDoc,
    writeFirestoreDoc,
    handleLimpiarDatos
};
