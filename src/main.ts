import path from 'path';
import {
  GraphqlApi,
  MappingTemplate,
  FieldLogLevel,
  SchemaFile,
} from '@aws-cdk/aws-appsync-alpha';
import { AuthorizationType } from '@aws-cdk/aws-appsync-alpha/lib/graphqlapi';
import { CustomSageMakerEndpoint, DeepLearningContainerImage, SageMakerInstanceType } from '@cdklabs/generative-ai-cdk-constructs';
import { App, CfnOutput, Duration, Expiration, Stack, StackProps } from 'aws-cdk-lib';
import { AllowedMethods, Distribution, HttpVersion, PriceClass, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  Effect,
  FederatedPrincipal, ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3';
import * as s3_deployment from 'aws-cdk-lib/aws-s3-deployment';
import { Choice, Condition, Fail, Pass, StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import * as dotenv from 'dotenv';

dotenv.config();

const SAGE_ENDPOINT_NAME = 'WhisperEndpoint';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Create S3 Bucket
    const voiceTranslatorBucket = new Bucket(this, 'VoiceTranslatorBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      websiteIndexDocument: 'voice-translator.html',
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [HttpMethods.GET, HttpMethods.PUT, HttpMethods.POST, HttpMethods.HEAD],
          allowedOrigins: ['*'],
          id: 'myCORSRuleId1',
          maxAge: 3600,
        },
      ],
    });

    // Upload model.tar.gz to S3
    const modelUpload = new s3_deployment.BucketDeployment(this, 'ModelUpload', {
      sources: [s3_deployment.Source.asset(path.join(__dirname, 'model', 'model.zip'))],
      destinationBucket: voiceTranslatorBucket,
      destinationKeyPrefix: 'sage',
    });

    // CloudFront Distribution
    const cfDistribution = new Distribution(this, 'CfDistribution', {
      defaultBehavior: {
        origin: new S3Origin(voiceTranslatorBucket),
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachedMethods: AllowedMethods.ALLOW_GET_HEAD,
        compress: false,
      },
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP1_1,
      enableIpv6: false,
      enabled: true,
      priceClass: PriceClass.PRICE_CLASS_ALL,
    });

    // AppSync GraphQL API
    const appSync2LiveTranslationApi = new GraphqlApi(
      this,
      'AppSyncLiveTranslationApi',
      {
        schema: SchemaFile.fromAsset(path.join(__dirname, 'graphql/schema.graphql')),
        name: 'AppSync2StepFunction-API',
        authorizationConfig: {
          defaultAuthorization: {
            authorizationType: AuthorizationType.API_KEY,
            apiKeyConfig: {
              name: 'AppSyncAPIKey',
              description: 'API Key for AppSyncLiveTranslationApi',
              expires: Expiration.after(Duration.days(365)),
            },
          },
        },
        logConfig: {
          fieldLogLevel: FieldLogLevel.ALL,
        },
      },
    );

    // CloudWatch Policy for Lambda Functions
    const cloudwatchPolicy = new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          effect: Effect.ALLOW,
          resources: ['arn:aws:logs:*:*:*'],
        }),
      ],
    });

    const sageMakerRole = new Role(this, 'SageMakerExecutionRole', {
      assumedBy: new ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
      ],
    });

    // Add S3 access permissions
    sageMakerRole.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        `${voiceTranslatorBucket.bucketArn}`, // This grants ListBucket
        `${voiceTranslatorBucket.bucketArn}/*`, // This grants GetObject on all objects
      ],
    }));

    // SageMaker Integration using CustomSageMakerEndpoint
    const whisperModel = new CustomSageMakerEndpoint(this, 'CustomWhisperModel', {
      modelId: 'bgeinf2',
      instanceType: SageMakerInstanceType.ML_M5_LARGE,
      container: DeepLearningContainerImage.fromDeepLearningContainerImage(
        'huggingface-pytorch-inference-neuronx',
        '1.13.1-transformers4.34.1-neuronx-py310-sdk2.15.0-ubuntu20.04',
      ),
      modelDataUrl: `s3://${voiceTranslatorBucket.bucketName}/sage/model.tar.gz`,
      endpointName: SAGE_ENDPOINT_NAME,
      instanceCount: 1,
      volumeSizeInGb: 100,
      minCapacity: 1,
      maxCapacity: 2,
      role: sageMakerRole,
    });

    // Ensure the model is uploaded before creating the SageMaker model
    whisperModel.node.addDependency(modelUpload);
    whisperModel.node.addDependency(sageMakerRole);

    // Grant read permissions (s3:GetObject)
    voiceTranslatorBucket.grantRead(sageMakerRole);
    voiceTranslatorBucket.grantRead(whisperModel);

    // Use sageMakerRole for Invoking SageMaker from Lambda
    const invokeSageMakerLambda = new NodejsFunction(this, 'InvokeSageMakerLambda', {
      handler: 'handler',
      entry: path.join(__dirname, 'lambda', 'invokeSageMaker.ts'),
      runtime: Runtime.NODEJS_18_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(30),
      environment: {
        SAGEMAKER_ENDPOINT_NAME: SAGE_ENDPOINT_NAME,
        BUCKET: voiceTranslatorBucket.bucketName,
        REGION: this.region || 'us-east-1',
      },
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
      },
    });

    invokeSageMakerLambda.addToRolePolicy(new PolicyStatement({
      actions: ['sagemaker:InvokeEndpoint'],
      resources: [whisperModel.endpointArn],
    }));

    invokeSageMakerLambda.addToRolePolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:PutObjectAcl'],
      resources: [
        `${voiceTranslatorBucket.bucketArn}`,
        `${voiceTranslatorBucket.bucketArn}/*`,
        `${voiceTranslatorBucket.bucketArn}/sage/*`,
      ],
    }));

    voiceTranslatorBucket.grantReadWrite(invokeSageMakerLambda);

    // Define TranslatePolly Lambda Role and Function
    const translatePollyLambdaRole = new Role(this, 'TranslatePollyLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        TranslateAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['translate:TranslateText'],
              effect: Effect.ALLOW,
              resources: ['*'],
            }),
          ],
        }),
        S3Access: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['s3:GetObject', 's3:PutObject', 's3:PutObjectAcl'],
              effect: Effect.ALLOW,
              resources: [`${voiceTranslatorBucket.bucketArn}/*`],
            }),
          ],
        }),
        BucketLocation: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['s3:GetBucketLocation'],
              effect: Effect.ALLOW,
              resources: ['arn:aws:s3:::*'],
            }),
          ],
        }),
        PollyAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['polly:SynthesizeSpeech'],
              effect: Effect.ALLOW,
              resources: ['*'],
            }),
          ],
        }),
        CloudWatchPolicy: cloudwatchPolicy,
      },
    });

    const translatePollyLambda = new NodejsFunction(this, 'translatePollyLambda', {
      handler: 'handler',
      entry: path.join(__dirname, 'lambda', 'translatePollyJob.ts'),
      role: translatePollyLambdaRole,
      runtime: Runtime.NODEJS_18_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(30),
      depsLockFilePath: './yarn.lock',
      environment: {
        API_GRAPHQLAPIENDPOINT: appSync2LiveTranslationApi.graphqlUrl || '',
        API_GRAPHQLAPIKEY: appSync2LiveTranslationApi.apiKey || '',
        REGION: this.region || 'us-east-1',
      },
      bundling: {
        minify: true,
        externalModules: ['aws-sdk'],
      },
    });

    // Define getTranscribeStatus Lambda Role and Function
    const getTranscribeStatusRole = new Role(this, 'getTranscribeStatusRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        TranscribeAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['transcribe:GetTranscriptionJob'],
              effect: Effect.ALLOW,
              resources: ['*'],
            }),
          ],
        }),
        CloudWatchPolicy: cloudwatchPolicy,
      },
    });

    const getTranscribeStatusLambda = new NodejsFunction(this,
      'getTranscribeStatusLambda', {
        handler: 'handler',
        entry: path.join(__dirname, 'lambda', 'getTranscribeStatus.ts'),
        role: getTranscribeStatusRole,
        runtime: Runtime.NODEJS_18_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(30),
        depsLockFilePath: './yarn.lock',
        environment: {
          REGION: this.region || 'us-east-1',
        },
        bundling: {
          minify: true,
          externalModules: ['aws-sdk'],
        },
      });

    // Define Step Functions Tasks
    const invokeSageMakerTask = new LambdaInvoke(this, 'invokeSageMakerLambdaTask', {
      lambdaFunction: invokeSageMakerLambda,
      outputPath: '$.Payload',
    });

    const getTranscribeStatus = new LambdaInvoke(this, 'Get Transcribe Job Status', {
      lambdaFunction: getTranscribeStatusLambda,
      outputPath: '$.Payload',
    });

    const translatePollyJob = new LambdaInvoke(this, 'Start Translate / Polly Job Status', {
      lambdaFunction: translatePollyLambda,
      outputPath: '$.Payload',
    });

    const jobFailed = new Fail(this, 'Job Failed', {
      cause: 'SageMaker Invocation Failed',
      error: 'Failed to invoke SageMaker endpoint or translation',
    });

    const jobSucceeded = new Choice(this, 'Was Translation Successful?')
      .when(Condition.stringEquals('$.status', 'SUCCEEDED'), new Pass(this, 'Job Succeeded'))
      .otherwise(jobFailed);

    const whisperTranslateDefinition = invokeSageMakerTask
      .next(getTranscribeStatus)
      .next(translatePollyJob)
      .next(jobSucceeded);

    const primaryStepFunction = new StateMachine(this, 'PrimaryStepFunction', {
      definition: whisperTranslateDefinition,
      timeout: Duration.minutes(5),
    });

    // Define Step Functions Start Lambda Role and Function
    const startSfnRole = new Role(this, 'startSfnRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        SfnStart: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['states:StartExecution'],
              effect: Effect.ALLOW,
              resources: [primaryStepFunction.stateMachineArn],
            }),
          ],
        }),
        CloudWatchPolicy: cloudwatchPolicy,
      },
    });

    const startTranslationSfnLambda = new NodejsFunction(this,
      'startTranslationSfnLambda', {
        handler: 'handler',
        entry: path.join(__dirname, 'lambda', 'startSfnLambda.ts'),
        role: startSfnRole,
        runtime: Runtime.NODEJS_18_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(30),
        depsLockFilePath: './yarn.lock',
        bundling: {
          minify: true,
          externalModules: ['aws-sdk'],
        },
        environment: {
          STATE_MACHINE_ARN: primaryStepFunction.stateMachineArn,
          REGION: this.region || 'us-east-1',
        },
      });

    // Create DynamoDB Table
    const translationRecordingTable = new Table(this, 'TranslationRecordingTable', {
      partitionKey: {
        name: 'jobId',
        type: AttributeType.STRING,
      },
    });

    // 15. AppSync Data Sources and Resolvers
    const translationRecordingDataSource = appSync2LiveTranslationApi.addDynamoDbDataSource(
      'translationRecordingDataSource',
      translationRecordingTable,
    );

    const startTranslationSfnDataSource = appSync2LiveTranslationApi.addLambdaDataSource(
      'startTranslationSfnDataSource',
      startTranslationSfnLambda,
      {
        name: 'startTranslationSfnDataSource',
        description: 'startTranslationSfnDataSource desc',
      },
    );

    translationRecordingDataSource.createResolver('getTranslationRecordings', {
      typeName: 'Query',
      fieldName: 'getTranslationRecordings',
      requestMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Query.getTranslationRecordings.req.vtl'),
      ),
      responseMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Query.getTranslationRecordings.req.vtl'),
      ),
    });


    translationRecordingDataSource.createResolver('ListTranslationRecordingsResolver', {
      typeName: 'Query',
      fieldName: 'listTranslationRecordings',
      requestMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Query.listTranslationRecordings.req.vtl'),
      ),
      responseMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Query.listTranslationRecordings.req.vtl'),
      ),
    });

    translationRecordingDataSource.createResolver('CreateTranslationRecordingsResolver', {
      typeName: 'Mutation',
      fieldName: 'createTranslationRecordings',
      requestMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Mutation.createTranslationRecordings.req.vtl'),
      ),
      responseMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Mutation.createTranslationRecordings.req.vtl'),
      ),
    });

    translationRecordingDataSource.createResolver('UpdateTranslationRecordingsResolver', {
      typeName: 'Mutation',
      fieldName: 'updateTranslationRecordings',
      requestMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Mutation.updateTranslationRecordings.req.vtl'),
      ),
      responseMappingTemplate: MappingTemplate.fromFile(
        path.join(__dirname, 'graphql/mappingTemplates/Mutation.updateTranslationRecordings.req.vtl'),
      ),
    });

    startTranslationSfnDataSource.createResolver('StartTranslationSfnResolver', {
      typeName: 'Mutation',
      fieldName: 'startTranslationSfn',
    });

    // Cognito User Pool and Identity Pool
    const userPool = new UserPool(this, 'VoicetranslatorUserPool', {
      selfSignUpEnabled: true, // Allow users to sign up
      signInAliases: {
        email: true, // Allow email as a sign-in alias
      },
    });

    // Create a User Pool Client
    const userPoolClient = new UserPoolClient(this, 'VoicetranslatorPoolClient', {
      userPool,
      generateSecret: false, // Set to true if you want a secret
    });

    // Create the Identity Pool
    const identityPool = new CfnIdentityPool(this, 'CognitoIdentityPool', {
      allowUnauthenticatedIdentities: true,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    // IAM Roles for Cognito Identity Pool
    const unAuthRole = new Role(this, 'CognitoUnAuthorizedRole', {
      assumedBy: new FederatedPrincipal('cognito-identity.amazonaws.com', {
        'StringEquals': {
          'cognito-identity.amazonaws.com:aud': identityPool.ref,
        },
        'ForAnyValue:StringEquals': {
          'cognito-identity.amazonaws.com:amr': 'unauthenticated',
        },
      }, 'sts:AssumeRoleWithWebIdentity'),
      inlinePolicies: {
        CognitoUnauthorizedPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              effect: Effect.ALLOW,
              resources: [
                invokeSageMakerLambda.functionArn,
                translatePollyLambda.functionArn,
                startTranslationSfnLambda.functionArn,
              ],
            }),
            new PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              effect: Effect.ALLOW,
              resources: [`${voiceTranslatorBucket.bucketArn}/*`],
            }),
            new PolicyStatement({
              actions: ['appsync:GraphQL'],
              effect: Effect.ALLOW,
              resources: [appSync2LiveTranslationApi.arn],
            }),
          ],
        }),
      },
    });


    // Create roles for authenticated and unauthenticated users
    const authRole = new Role(this, 'CognitoAuthorizedRole', {
      assumedBy: new FederatedPrincipal('cognito-identity.amazonaws.com', {
        'StringEquals': {
          'cognito-identity.amazonaws.com:aud': identityPool.ref,
        },
        'ForAnyValue:StringEquals': {
          'cognito-identity.amazonaws.com:amr': 'authenticated',
        },
      }, 'sts:AssumeRoleWithWebIdentity'),
      inlinePolicies: {
        AuthPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              effect: Effect.ALLOW,
              resources: [
                invokeSageMakerLambda.functionArn,
                translatePollyLambda.functionArn,
                startTranslationSfnLambda.functionArn,
              ],
            }),
            new PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              effect: Effect.ALLOW,
              resources: [`${voiceTranslatorBucket.bucketArn}/*`],
            }),
            new PolicyStatement({
              actions: ['appsync:GraphQL'],
              effect: Effect.ALLOW,
              resources: [appSync2LiveTranslationApi.arn],
            }),
          ],
        }),
      },
    });

    // DynamoDB Grant
    translationRecordingTable.grantReadWriteData(translatePollyLambda);

    // Attach Roles to Identity Pool
    new CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleMapping', {
      identityPoolId: identityPool.ref,
      roles: {
        unauthenticated: unAuthRole.roleArn,
        authenticated: authRole.roleArn,
      },
    });

    // Outputs
    new CfnOutput(this, 'CfnDistribution', {
      description: 'Domain name for our CloudFront distribution',
      value: `https://${cfDistribution.distributionDomainName}/voice-translator.html`,
    });

    new CfnOutput(this, 'VoiceTranslatorBucketOutput', {
      description: 'VoiceTranslator S3 Bucket',
      value: voiceTranslatorBucket.bucketName,
    });

    new CfnOutput(this, 'IdentityPoolIdOutput', {
      description: 'IdentityPoolId',
      value: identityPool.ref,
    });

    new CfnOutput(this, 'InvokeSageMakerLambdaARN', {
      description: 'ARN of the InvokeSageMaker Lambda Function',
      value: invokeSageMakerLambda.functionArn,
    });

    new CfnOutput(this, 'TranslatePollyLambdaARN', {
      description: 'ARN of the TranslatePolly Lambda Function',
      value: translatePollyLambda.functionArn,
    });

    new CfnOutput(this, 'startSfnLambda', {
      description: 'startSfnLambda Lambda',
      value: startTranslationSfnLambda.functionArn,
    });

    new CfnOutput(this, 'AppSyncGraphQLAPIEndpoint', {
      description: 'GraphQL API Endpoint',
      value: appSync2LiveTranslationApi.graphqlUrl,
    });

  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new MyStack(app, 'translation-walkie-talkie-dev', { env: devEnv });
// new MyStack(app, 'translation-walkie-talkie-prod', { env: prodEnv });

app.synth();