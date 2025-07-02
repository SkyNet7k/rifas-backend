// adminUtils.js
const admin = require('firebase-admin');
const moment = require('moment-timezone');

/**
 * Lee un documento específico de Firestore.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb o secondaryDb).
 * @param {string} collectionName - El nombre de la colección.
 * @param {string} docId - El ID del documento.
 * @returns {Promise<object|null>} El objeto del documento si existe, o null.
 */
async function readFirestoreDoc(dbInstance, collectionName, docId) {
    if (!dbInstance) {
        console.warn(`readFirestoreDoc: dbInstance no está definida para leer ${collectionName}/${docId}.`);
        return null;
    }
    try {
        const docRef = dbInstance.collection(collectionName).doc(docId);
        const doc = await docRef.get();
        if (doc.exists) {
            return doc.data();
        } else {
            // Se usa ?.name para evitar errores si dbInstance.app es undefined
            console.log(`Documento ${docId} no encontrado en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}.`);
            return null;
        }
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error leyendo documento ${docId} en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error);
        throw error; // Re-lanzar el error para que sea manejado por el llamador
    }
}

/**
 * Escribe (establece o actualiza) un documento en Firestore.
 * Si el documento no existe, lo crea. Si existe, lo sobrescribe o fusiona.
 * @param {object} dbInstance - La instancia de Firestore (primaryDb o secondaryDb).
 * @param {string} collectionName - El nombre de la colección.
 * @param {string} docId - El ID del documento.
 * @param {object} data - Los datos a escribir.
 * @param {boolean} merge - Si es true, fusiona los datos con el documento existente. Si es false, sobrescribe.
 * @returns {Promise<boolean>} True si la operación fue exitosa.
 */
async function writeFirestoreDoc(dbInstance, collectionName, docId, data, merge = true) {
    if (!dbInstance) {
        console.warn(`writeFirestoreDoc: dbInstance no está definida para escribir ${collectionName}/${docId}.`);
        return false;
    }
    try {
        const docRef = dbInstance.collection(collectionName).doc(docId);
        await docRef.set(data, { merge });
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.log(`Documento ${docId} escrito/actualizado en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}.`);
        return true;
    } catch (error) {
        // Se usa ?.name para evitar errores si dbInstance.app es undefined
        console.error(`Error escribiendo documento ${docId} en colección ${collectionName} de ${dbInstance.app?.name || 'unknown_db'}:`, error);
        throw error;
    }
}

/**
 * Función para limpiar todos los datos de la base de datos de Firestore
 * y reiniciar la configuración de la aplicación.
 * @param {object} primaryDb - La instancia de Firestore principal.
 * @param {object|null} secondaryDb - La instancia de Firestore secundaria (puede ser null).
 * @param {object} configuracionGlobal - La configuración global actual del servidor.
 * @param {string} CARACAS_TIMEZONE - La zona horaria de Caracas.
 * @param {function} loadInitialDataFn - Función para recargar los datos iniciales del servidor.
 * @param {object} res - Objeto de respuesta de Express.
 */
async function handleLimpiarDatos(primaryDb, secondaryDb, configuracionGlobal, CARACAS_TIMEZONE, loadInitialDataFn, res) {
    console.log('Iniciando proceso de limpieza de datos en Firestore (Primary)...');
    try {
        // Colecciones a limpiar (ajusta según tus necesidades)
        const collectionsToClear = ['raffle_numbers', 'sales', 'lottery_times', 'draw_results', 'prizes', 'winners'];

        for (const collectionName of collectionsToClear) {
            console.log(`Limpiando colección: ${collectionName} en Primary DB.`);
            const snapshot = await primaryDb.collection(collectionName).get();
            const batch = primaryDb.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`Colección ${collectionName} limpiada en Primary DB.`);

            // Intentar limpiar también en la secundaria si está disponible
            if (secondaryDb) {
                try {
                    console.log(`Limpiando colección: ${collectionName} en Secondary DB.`);
                    const secondarySnapshot = await secondaryDb.collection(collectionName).get();
                    const secondaryBatch = secondaryDb.batch();
                    secondarySnapshot.docs.forEach((doc) => {
                        secondaryBatch.delete(doc.ref);
                    });
                    await secondaryBatch.commit();
                    console.log(`Colección ${collectionName} limpiada en Secondary DB.`);
                } catch (secondaryError) {
                    console.error(`Error limpiando colección ${collectionName} en Secondary DB:`, secondaryError);
                }
            }
        }

        // Reiniciar la configuración principal de la aplicación en ambas DBs
        const defaultAppConfig = {
            pagina_bloqueada: false,
            block_reason_message: "",
            fecha_sorteo: moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0,
            tasa_dolar: 36.50, // Valor por defecto
            admin_email_for_reports: configuracionGlobal.admin_email_for_reports || [], // Mantener correos de reporte
            admin_whatsapp_numbers: configuracionGlobal.admin_whatsapp_numbers || [], // Mantener números de WhatsApp
            raffleNumbersInitialized: false, // Resetear para que se reinicialicen los números de rifa
            last_sales_notification_count: 0,
            sales_notification_threshold: 20
        };
        await writeFirestoreDoc(primaryDb, 'app_config', 'main_config', defaultAppConfig, false); // Sobrescribir completamente en Primary
        if (secondaryDb) {
            try {
                await writeFirestoreDoc(secondaryDb, 'app_config', 'main_config', defaultAppConfig, false); // Sobrescribir completamente en Secondary
            } catch (secondaryError) {
                console.error('Error reiniciando app_config en Secondary DB:', secondaryError);
            }
        }

        // Reiniciar horarios y premios a valores por defecto (vacíos o iniciales) en ambas DBs
        const defaultLotteryTimes = { zulia: [], chance: [] };
        await writeFirestoreDoc(primaryDb, 'lottery_times', 'zulia_chance', defaultLotteryTimes, false);
        if (secondaryDb) {
            try {
                await writeFirestoreDoc(secondaryDb, 'lottery_times', 'zulia_chance', defaultLotteryTimes, false);
            } catch (secondaryError) {
                console.error('Error reiniciando lottery_times en Secondary DB:', secondaryError);
            }
        }

        const defaultPrizes = {};
        await writeFirestoreDoc(primaryDb, 'prizes', 'daily_prizes', defaultPrizes, false);
        if (secondaryDb) {
            try {
                await writeFirestoreDoc(secondaryDb, 'prizes', 'daily_prizes', defaultPrizes, false);
            } catch (secondaryError) {
                console.error('Error reiniciando prizes en Secondary DB:', secondaryError);
            }
        }

        // Recargar todos los datos iniciales, lo que también reinicializará 'raffle_numbers'
        // Esta función (loadInitialDataFn) debe ser la del server.js y manejar la inicialización en ambas DBs.
        await loadInitialDataFn();

        res.status(200).json({ message: 'Todos los datos de la base de datos han sido limpiados y la configuración reiniciada a valores por defecto. Los números de la rifa han sido reinicializados.' });

    } catch (error) {
        console.error('Error durante la limpieza de datos en Firestore (Primary):', error);
        res.status(500).json({ message: 'Error interno del servidor al limpiar los datos.', error: error.message });
    }
}

module.exports = {
    readFirestoreDoc,
    writeFirestoreDoc,
    handleLimpiarDatos
};
