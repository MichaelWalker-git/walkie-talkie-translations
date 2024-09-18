const { awscdk } = require('projen');
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.1.0',
  defaultReleaseBranch: 'main',
  name: 'translation-walkie-talkie',

  deps: [
    'dotenv',
    '@aws-cdk/aws-appsync-alpha',
    '@aws-sdk/client-transcribe',
    'axios',
    '@aws-sdk/client-polly',
    'node-fetch',
    '@aws-sdk/client-translate',
    '@aws-sdk/client-s3',
    '@aws-sdk/client-sfn',
  ], /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();