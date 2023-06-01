import { Check } from 'react-bootstrap-icons';
import { MicFill, SquareFill } from 'react-bootstrap-icons';

const StatusBoard = ({step}) => {
    step = step - 1;
    const stepText = 
    [
    ["Record", "Recording...","Recorded"],
    ["Upload", "Uploading...","Uploaded"],
    ["Transcribe", "Transcribing...","Transcribed"],
    ["Translate", "Translating...","Translated"]
    ];
    
    
   return (
    <>  
    <div id="steps" className="mx-auto">
    
    
    <div className="architecture_icons container-fluid px-0">
    <div className={"d-flex flex-row justify-content-around step_"+step}>
        {(step === 1 || step === 2 || step === 3) && 
        <>
        <img src="amazon_transcribe.png" />
        <img src="amazon_translate.png" />
        <img src="amazon_polly.png" />
        </>
        }
    </div>
    </div>
    <div className="mt-5 text-center mx-auto row" aria-live="polite">
    <h2 id="header_step" tabIndex="-1">
    {(step === -1) &&
        <>Record your voice by clicking the <MicFill color="#000000" size={25} />record button.</>
    }
    {(step === 0) &&
        <>Speak out loud, then click <SquareFill color="#000000" size={18} /> stop when done.</>
    }    
    {(step === 1) &&
        <>Transcribing your voice into text with <strong>Amazon Transcribe</strong>.</>
    }
    {(step === 2) &&
        <>Translating the text with <strong>Amazon Translate</strong>.</>
    }
    {(step === 3) &&
        <>Generating an audio clip using <strong>Amazon Polly</strong>.</>
    }    
    {(step === 4) &&
        <>Playing the generated audio.</>
    }
    {(step === 5) &&
        <>Done.</>
    }</h2>
    
    </div>
    </div>    
    </>
   )
  
};

export default StatusBoard;
