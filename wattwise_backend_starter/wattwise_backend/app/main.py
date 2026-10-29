import io, os
from dataclasses import asdict
from dotenv import load_dotenv
load_dotenv()
import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from engine.energy_analysis import AnalysisConfig, EnergyAnalysisError, analyze_energy
from app.database import init_db, save_analysis, list_analyses, get_analysis, update_analysis_result
from app.schemas import AnalysisConfigIn, WhatIfIn
from app.nebius_client import explain_analysis
from app.bill_parser import process_uploaded_bill_or_csv

app = FastAPI(
    title='WattWise API',
    version='1.1.0',
    description='Energy analysis, bill OCR ingestion (PNG/JPG/PDF/CSV), what-if simulations, history, and Nemotron explanations.'
)

# Open CORS configuration to prevent browser 'Failed to fetch' errors
cors_env = os.getenv('WATTWISE_CORS_ORIGINS', '*').strip()
origins = ['*'] if cors_env == '*' else [x.strip() for x in cors_env.split(',') if x.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
    expose_headers=['*']
)

@app.on_event('startup')
def startup():
    init_db()

def parse_csv(csv_text: str):
    try:
        return pd.read_csv(io.StringIO(csv_text))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'Could not parse CSV: {exc}') from exc

@app.get('/')
def root():
    return {
        'name': 'WattWise API',
        'status': 'running',
        'supported_bill_formats': ['csv', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'pdf'],
        'docs': '/docs',
        'health': '/health'
    }

@app.get('/health')
def health():
    return {'status': 'ok', 'service': 'wattwise-api'}

@app.post('/api/analyze')
async def upload_and_analyze(
    file: UploadFile = File(...),
    electricity_rate: float = Form(8.0),
    overnight_start_hour: int = Form(0),
    overnight_end_hour: int = Form(6),
    anomaly_sigma: float = Form(3.0),
    avoidable_percent: float = Form(50.0),
    annualize_daily_savings: bool = Form(True)
):
    if not file.filename:
        raise HTTPException(400, 'Uploaded file must have a filename.')
    
    lower_name = file.filename.lower()
    allowed_exts = ('.csv', '.tsv', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.pdf')
    if not lower_name.endswith(allowed_exts):
        raise HTTPException(
            415,
            f"Unsupported file type. Please upload an electricity bill image (.png, .jpg, .jpeg, .webp), PDF, or CSV telemetry."
        )

    content = await file.read()
    max_bytes = int(os.getenv('WATTWISE_MAX_UPLOAD_BYTES', str(20 * 1024 * 1024)))
    if len(content) > max_bytes:
        raise HTTPException(413, f'File exceeds upload limit of {max_bytes} bytes.')

    try:
        df, csv_text, bill_data, file_type = await process_uploaded_bill_or_csv(content, file.filename)
    except Exception as exc:
        raise HTTPException(422, detail=f"Failed to process bill file: {exc}") from exc

    # If bill contains an explicit tariff rate and user did not override default 8.0, calibrate rate
    effective_rate = electricity_rate
    if bill_data and bill_data.get('tariff_rate') and electricity_rate == 8.0:
        try:
            effective_rate = float(bill_data['tariff_rate'])
        except Exception:
            pass

    try:
        config_model = AnalysisConfigIn(
            electricity_rate=effective_rate,
            overnight_start_hour=overnight_start_hour,
            overnight_end_hour=overnight_end_hour,
            anomaly_sigma=anomaly_sigma,
            avoidable_percent=avoidable_percent,
            annualize_daily_savings=annualize_daily_savings
        )
        config = AnalysisConfig(**config_model.model_dump())
        result = analyze_energy(df, config)
    except (EnergyAnalysisError, ValueError) as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    if bill_data:
        result['bill_details'] = bill_data
        result['file_type'] = file_type

    analysis_id = save_analysis(file.filename, asdict(config), result, csv_text)
    return {
        'id': analysis_id,
        'filename': file.filename,
        'file_type': file_type,
        'result': result,
        'bill_details': bill_data
    }

@app.get('/api/analyses')
def history(limit: int = 20):
    if not 1 <= limit <= 100:
        raise HTTPException(400, 'limit must be between 1 and 100.')
    return {'items': list_analyses(limit)}

@app.get('/api/analyses/{analysis_id}')
def detail(analysis_id: int):
    item = get_analysis(analysis_id)
    if item is None:
        raise HTTPException(404, 'Analysis not found.')
    item.pop('csv_text', None)
    return item

@app.post('/api/analyses/{analysis_id}/what-if')
def what_if(analysis_id: int, payload: WhatIfIn):
    item = get_analysis(analysis_id)
    if item is None:
        raise HTTPException(404, 'Analysis not found.')
    config = AnalysisConfig(**payload.model_dump())
    try:
        result = analyze_energy(parse_csv(item['csv_text']), config)
    except (EnergyAnalysisError, ValueError) as exc:
        raise HTTPException(422, detail=str(exc)) from exc
    update_analysis_result(analysis_id, asdict(config), result)
    return {'id': analysis_id, 'result': result}

@app.post('/api/analyses/{analysis_id}/explain')
async def explain(analysis_id: int):
    item = get_analysis(analysis_id)
    if item is None:
        raise HTTPException(404, 'Analysis not found.')
    try:
        explanation = await explain_analysis(item['result'])
    except RuntimeError as exc:
        raise HTTPException(503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, detail='Nemotron explanation failed. Check backend logs and model configuration.') from exc
    return {'id': analysis_id, 'explanation': explanation}
