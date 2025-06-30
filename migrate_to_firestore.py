import firebase_admin
from firebase_admin import credentials
from firebase_admin import firestore
import json
import os
from datetime import datetime, timezone, timedelta
import time # Importar time para generar IDs de ventas si es necesario

# --- Configuración de Firebase Admin SDK ---
# Asegúrate de que la variable de entorno FIREBASE_SERVICE_ACCOUNT_KEY
# esté configurada con el contenido de tu archivo JSON de credenciales.
# Por ejemplo, en tu terminal:
# export FIREBASE_SERVICE_ACCOUNT_KEY="$(cat tu-oportunidades-hoy-firebase-adminsdk-fbsvc-xxxxxxxxxx.json)"
# O carga el archivo directamente si lo prefieres para desarrollo local
try:
    # Intenta cargar desde la variable de entorno
    cred_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT_KEY')
    if cred_json:
        cred = credentials.Certificate(json.loads(cred_json))
    else:
        # Si no está en la variable de entorno, intenta cargar el archivo directamente
        # Asegúrate de que el nombre del archivo coincida con el tuyo
        cred = credentials.Certificate("tu-oportunidad-es-hoy-firebase-adminsdk-fbsvc-781e9f9dc1.json")
    
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("Firebase Admin SDK inicializado exitosamente.")
except Exception as e:
    print(f"Error al inicializar Firebase Admin SDK: {e}")
    print("Asegúrate de que el archivo de credenciales de Firebase esté en el directorio correcto")
    print("o que la variable de entorno 'FIREBASE_SERVICE_ACCOUNT_KEY' esté configurada.")
    exit()

# --- Rutas a tus archivos JSON ---
# Asegúrate de que estos nombres de archivo coincidan exactamente con los de tu proyecto.
CONFIGURACION_FILE = 'configuracion.json'
NUMEROS_FILE = 'numeros.json'
HORARIOS_ZULIA_FILE = 'horarios_zulia.json'
GANADORES_FILE = 'ganadores.json'
PREMIOS_FILE = 'premios.json'
VENTAS_FILE = 'ventas.json'
RESULTADOS_ZULIA_FILE = 'resultados_zulia.json'
COMPROBANTES_FILE = 'comprobantes.json'

# --- Funciones de Ayuda ---

def load_json(filepath):
    """Carga un archivo JSON y devuelve su contenido."""
    if not os.path.exists(filepath):
        print(f"Advertencia: Archivo '{filepath}' no encontrado. Se omitirá la migración para este archivo.")
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        print(f"Error al decodificar JSON en '{filepath}': {e}")
        return None
    except Exception as e:
        print(f"Error al cargar '{filepath}': {e}")
        return None

def get_venezuela_time():
    """Obtiene la hora actual en la zona horaria de Venezuela."""
    venezuela_tz = timezone(timedelta(hours=-4)) # UTC-4 para Venezuela
    return datetime.now(venezuela_tz)

def format_timestamp(dt_object):
    """Formatea un objeto datetime a string 'YYYY-MM-DD HH:mm:ss'."""
    return dt_object.strftime('%Y-%m-%d %H:%M:%S')

# --- Lógica de Migración ---

async def migrate_data():
    print("Iniciando migración de datos a Firestore...")

    # 1. Migrar Configuración
    configuracion_data = load_json(CONFIGURACION_FILE)
    if configuracion_data:
        try:
            doc_ref = db.collection('configuracion').document('general')
            doc_ref.set(configuracion_data) # Eliminado 'await'
            print("Configuración migrada exitosamente a 'configuracion/general'.")
        except Exception as e:
            print(f"Error al migrar configuración: {e}")

    # 2. Migrar Números
    numeros_data = load_json(NUMEROS_FILE)
    if numeros_data:
        batch_size = 500
        for i in range(0, len(numeros_data), batch_size):
            batch = db.batch()
            segment = numeros_data[i:i + batch_size]
            for numero_item in segment:
                doc_ref = db.collection('numeros').document(numero_item['numero'])
                batch.set(doc_ref, numero_item)
            try:
                batch.commit() # Eliminado 'await'
                print(f"Batch de números comprometido, total: {min(i + batch_size, len(numeros_data))}")
            except Exception as e:
                print(f"Error al comprometer batch de números: {e}")
        # Asegurarse de commitear el último batch si hay elementos restantes y no se hizo en el bucle
        # Ya que el bucle itera con el rango completo, no siempre queda un batch parcial al final que necesite un commit extra.
        # El batch.commit() ya se hace dentro del bucle para cada segmento.

        print(f"Migrados {len(numeros_data)} números a la colección 'numeros'.")

    # 3. Migrar Horarios Zulia
    horarios_zulia_data = load_json(HORARIOS_ZULIA_FILE)
    if horarios_zulia_data:
        # Si es un array, se puede guardar como un documento con un ID fijo que contenga el array.
        # O si cada elemento es un horario independiente, añadirlos individualmente.
        # Asumiendo que horarios_zulia.json contiene un array de horarios que queremos en un solo documento:
        try:
            doc_ref = db.collection('horarios_zulia').document('horarios_principales')
            doc_ref.set({'horarios': horarios_zulia_data}) # Guarda el array dentro de un campo 'horarios'
            print(f"Migrados {len(horarios_zulia_data)} horarios de Zulia a 'horarios_zulia/horarios_principales'.")
        except Exception as e:
            print(f"Error al migrar horarios de Zulia: {e}")

    # 4. Migrar Ganadores
    ganadores_data = load_json(GANADORES_FILE)
    if ganadores_data:
        for ganador in ganadores_data:
            try:
                db.collection('ganadores').add(ganador) # Eliminado 'await'
            except Exception as e:
                print(f"Error al migrar ganador: {ganador} - {e}")
        print(f"Migrados {len(ganadores_data)} ganadores a la colección 'ganadores'.")

    # 5. Migrar Premios
    premios_data = load_json(PREMIOS_FILE)
    if premios_data:
        try:
            doc_ref = db.collection('premios').document('general')
            doc_ref.set(premios_data) # Eliminado 'await'
            print("Premios migrados exitosamente a 'premios/general'.")
        except Exception as e:
            print(f"Error al migrar premios: {e}")
    
    # 6. Migrar Ventas
    ventas_data = load_json(VENTAS_FILE)
    if ventas_data:
        batch_size = 500
        for i in range(0, len(ventas_data), batch_size):
            batch = db.batch()
            segment = ventas_data[i:i + batch_size]
            for venta in segment:
                # Firestore generará un ID automático para cada documento
                # Si quieres usar un ID específico de la venta (ej. ticketNumber), asegúrate de que sea único.
                # doc_ref = db.collection('ventas').document(str(venta.get('ticketNumber') or venta.get('id') or int(time.time() * 1000)))
                # batch.set(doc_ref, venta)
                batch.set(db.collection('ventas').document(), venta) # Dejar que Firestore genere el ID
            try:
                batch.commit() # Eliminado 'await'
                print(f"Batch de ventas comprometido, total: {min(i + batch_size, len(ventas_data))}")
            except Exception as e:
                print(f"Error al comprometer batch de ventas: {e}")
        print(f"Migradas {len(ventas_data)} ventas a la colección 'ventas'.")

    # 7. Migrar Resultados Zulia
    resultados_zulia_data = load_json(RESULTADOS_ZULIA_FILE)
    if resultados_zulia_data:
        for resultado in resultados_zulia_data:
            try:
                db.collection('resultados_zulia').add(resultado) # Eliminado 'await'
            except Exception as e:
                print(f"Error al migrar resultado de Zulia: {resultado} - {e}")
        print(f"Migrados {len(resultados_zulia_data)} resultados de Zulia a la colección 'resultados_zulia'.")

    # 8. Migrar Comprobantes
    comprobantes_data = load_json(COMPROBANTES_FILE)
    if comprobantes_data:
        for comprobante in comprobantes_data:
            try:
                # Firestore generará un ID automático para cada documento
                db.collection('comprobantes').add(comprobante) # Eliminado 'await'
            except Exception as e:
                print(f"Error al migrar comprobante: {comprobante} - {e}")
        print(f"Migrados {len(comprobantes_data)} comprobantes a la colección 'comprobantes'.")


    print("Migración de datos a Firestore completada. Por favor, verifica en la consola de Firebase.")
    print("Recuerda: Una vez que los datos estén en Firestore, tu backend en Render utilizará Firestore y no tus archivos JSON locales.")
    print("Asegúrate de configurar la variable de entorno FIREBASE_SERVICE_ACCOUNT_KEY en Render para que tu backend pueda conectarse a Firestore.")

# Ejecutar la migración
if __name__ == "__main__":
    import asyncio
    asyncio.run(migrate_data())
