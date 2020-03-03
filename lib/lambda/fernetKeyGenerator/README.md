# AWS Lambda / Python Version Notes

Note - the python `cryptography` module was compiled on an Amazon Linux environment (AWS Cloud9) on Python version 3.6. Because this library was specifically built against that runtime, you need to run an AWS Lambda with the same version. If you use a different version (e.g. Lambda Python 3.8), this function will likely result in errors. 

See this issue for additional examples /detail: 
https://github.com/inducer/pyopencl/issues/95
