FROM puckel/docker-airflow:1.10.9

USER root

COPY airflow.cfg ./airflow.cfg
COPY /dags ./dags

COPY entrypoint.sh /entrypoint.sh

# For python dependencies
COPY requirements.txt /requirements.txt

# Add directory in which pip installs to PATH
ENV PATH="/usr/local/airflow/.local/bin:${PATH}"

# Install Git for airflow-code-editor:
RUN apt update      
RUN apt install -y git

# Grant read/write on ./dags to all users so that airflow user can use airflow-code-editor:
# Note - this can probably be scoped down for better security:
RUN chmod -R a+rw ./dags

USER airflow

ENTRYPOINT ["/entrypoint.sh"]

# Just for documentation. Expose webserver, worker and flower respectively
EXPOSE 8080
EXPOSE 8793
EXPOSE 5555