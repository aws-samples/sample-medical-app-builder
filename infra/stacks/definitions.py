"""
An app's own FHIR definitions — the Questionnaires behind forms designed in the drafting conversation — travel in its
manifest and, when the app is published, are also written to the record the apps run on. Which Lambda writes them is
a deployment fact (the data source's seed Lambda holds the server's credentials), published by that server's stack as
an SSM parameter and read by the registry write API at first use. Discovery through a parameter rather than a
construct reference keeps the authoring stack from depending on the servers' stacks, which depend on it.
"""

DEFINITIONS_WRITER_PARAMETER = "/medapp/{hospital_id}/data-source/definitions-writer"
