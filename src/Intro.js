import React, { useEffect, useState } from "react";
import App from './App';
import Button from "@cloudscape-design/components/button"

import { Arrow90degLeft, BoxArrowRight } from 'react-bootstrap-icons';

const Intro = ({signOut}) => {
    const [showApp, setShowApp] = useState(false);
    return (        
    <div className="container-fluid pt-4">
    {(!showApp) ? (
        <>            
            
            
        
        <div id="intro" className="mt-5 p-5 row">
            <div className="col-9">
            <Button variant="link" id="signOut" onClick={signOut}><BoxArrowRight size={18}></BoxArrowRight></Button>
            <img src="aws_logo.svg" alt="AWS" style={{'width':'120px','margin-bottom':'60px'}}/>
       
            <h1 className="text-start">Translation Demo</h1>        
            
            <h2 className="text-start">See how Amazon Transcribe, Amazon Translate, and Amazon Polly work together to form a simple translation app.</h2>
            <p className="mt-5"><Button variant="primary" onClick={()=>setShowApp(true)}>Start Demo</Button>
            </p>
            </div>
        </div>
        </>
    ) : (
        <>
        <App showIntro={()=>setShowApp(false)} />
        </>
    )}        
    </div>

    )
};

export default Intro;