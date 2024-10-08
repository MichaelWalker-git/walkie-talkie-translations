
import { Readable } from 'stream';
import {
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
} from '@aws-sdk/client-sagemaker-runtime';
import { APIGatewayProxyHandler } from 'aws-lambda';

// Initialize AWS SDK clients
const s3Client = new S3Client({ region: process.env.REGION || 'us-east-1' });
const sageMakerClient = new SageMakerRuntimeClient({ region: process.env.REGION || 'us-east-1' });

interface InvokeSageMakerInput {
  bucket: string;
  key: string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    // Parse the incoming event body
    const body = JSON.parse(event.body || '{}') as InvokeSageMakerInput;
    const { bucket, key } = body;

    if (!bucket || !key) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Missing bucket or key in request body.' }),
      };
    }

    // Retrieve the audio file from S3
    const getObjectParams = {
      Bucket: bucket,
      Key: key,
    };
    const getObjectCommand = new GetObjectCommand(getObjectParams);
    const s3Response = await s3Client.send(getObjectCommand);

    if (!s3Response.Body) {
      throw new Error('Audio file is empty.');
    }

    // Convert S3 Body to Buffer
    const audioBuffer = await bodyToBuffer(s3Response.Body);

    // Prepare the payload for SageMaker
    const payload = {
      audio: audioBuffer.toString('base64'), // Adjust based on your model's input requirements
    };

    // Invoke SageMaker Endpoint
    const invokeEndpointParams = {
      EndpointName: process.env.SAGEMAKER_ENDPOINT_NAME!,
      ContentType: 'application/json', // Adjust based on your model's requirements
      Body: Buffer.from(JSON.stringify(payload)),
    };
    const invokeEndpointCommand = new InvokeEndpointCommand(invokeEndpointParams);
    const sageMakerResponse = await sageMakerClient.send(invokeEndpointCommand);

    if (!sageMakerResponse.Body) {
      throw new Error('SageMaker response body is empty.');
    }

    // Convert SageMaker response body to string
    const transcriptionResult = await bodyToString(sageMakerResponse.Body);

    return {
      statusCode: 200,
      body: JSON.stringify({ transcription: transcriptionResult }),
    };
  } catch (error: any) {
    console.error('Error invoking SageMaker:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
    };
  }
};

// Helper function to convert a ReadableStream<any> & SdkStreamMixin to Buffer
async function bodyToBuffer(body: any): Promise<Buffer> {
  // Convert ReadableStream to Node.js Readable
  const readable = Readable.fromWeb(body as any); // TypeScript may need 'as any'
  return streamToBuffer(readable);
}

// Helper function to convert a Readable stream to a Buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err));
  });
}

// Helper function to convert a ReadableStream<any> & SdkStreamMixin to string
async function bodyToString(body: any): Promise<string> {
  const buffer = await bodyToBuffer(body);
  return buffer.toString('utf-8');
}
